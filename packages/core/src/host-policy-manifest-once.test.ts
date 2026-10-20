import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  resolveTargetPolicyDetailed,
  scanDiagnosticsNotSaidByPolicy,
} from "./host-policy.ts";
import { clearManifestCache, scanCustomTags } from "./scan.ts";
import type { TargetLookup } from "./target-descriptor.ts";
import { createTargetLookup } from "./target-descriptor.ts";

/**
 * One problem, one message: a `package.json` that fails to parse reaches a
 * tool twice today — the host policy's `malformed-package-json` diagnostic
 * (positioned at the parse error) and the tag scan's `MX_IGNORED_CONFIG`
 * diagnostic (positioned at 1:1). The policy message now carries the scan's
 * consequence, and `scanDiagnosticsNotSaidByPolicy` drops the scan twin.
 * These tests pin the wording and the filter's edges; the golden row
 * `bad-package-json` pins the language server and `mx-tsc` end to end.
 */

const lookup: TargetLookup = createTargetLookup([
  {
    descriptorVersion: 0,
    name: "page",
    packageName: "@t/page",
    defaultTag: "node",
  },
]);

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function project(manifest: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-manifest-once-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), manifest);
  return join(dir, "page.mx");
}

describe("scanDiagnosticsNotSaidByPolicy", () => {
  it("drops the scan's manifest-parse twin of a policy diagnostic", () => {
    const kept = scanDiagnosticsNotSaidByPolicy(
      [{ file: "/a/package.json", code: "malformed-package-json" }],
      [
        {
          file: "/a/package.json",
          message:
            "`package.json` could not be parsed as JSON: boom; no `mx.tags` are loaded",
          line: 1,
          column: 0,
          code: "MX_IGNORED_CONFIG",
        },
      ],
    );
    expect(kept).toEqual([]);
  });

  it("keeps every other scan diagnostic, in the same file or another", () => {
    const others = [
      {
        file: "/a/package.json",
        message: "`mx.tags` names a directory that does not exist: tags",
        line: 1,
        column: 0,
        code: "MX_IGNORED_CONFIG",
      },
      {
        file: "/b/package.json",
        message: "`package.json` could not be parsed as JSON: boom",
        line: 1,
        column: 0,
        code: "MX_IGNORED_CONFIG",
      },
    ];
    expect(
      scanDiagnosticsNotSaidByPolicy(
        [{ file: "/a/package.json", code: "malformed-package-json" }],
        others,
      ),
    ).toEqual(others);
  });

  it("keeps the manifest-parse diagnostic when no policy twin exists", () => {
    const scan = [
      {
        file: "/a/package.json",
        message: "`package.json` could not be parsed as JSON: boom",
        line: 1,
        column: 0,
        code: "MX_IGNORED_CONFIG",
      },
    ];
    expect(scanDiagnosticsNotSaidByPolicy([], scan)).toEqual(scan);
    expect(
      scanDiagnosticsNotSaidByPolicy(
        [{ file: "/a/package.json", code: "unknown-host" }],
        scan,
      ),
    ).toEqual(scan);
  });
});

describe("malformed-package-json wording", () => {
  it("a fresh project says no mx.tags are loaded until the manifest parses", () => {
    clearManifestCache();
    const file = project('{ "name": "a", mx: }');
    const { diagnostics } = resolveTargetPolicyDetailed(file, lookup);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("malformed-package-json");
    expect(diagnostics[0]?.message).toContain(
      "no `mx.tags` or `mx.contracts` are loaded until the manifest parses",
    );
  });

  it("a previously valid manifest says the previous mx.tags stay in force", () => {
    clearManifestCache();
    const file = project('{ "name": "a" }');
    resolveTargetPolicyDetailed(file, lookup);
    writeFileSync(join(file, "..", "package.json"), '{ "name": "a", mx: }');
    const { diagnostics } = resolveTargetPolicyDetailed(file, lookup);
    expect(diagnostics[0]?.message).toContain(
      "the previous valid `mx.tags` and `mx.contracts` stay in force",
    );
  });

  it("a manifest that parses but is not an object keeps the plain wording", () => {
    clearManifestCache();
    const file = project("[]");
    const { diagnostics } = resolveTargetPolicyDetailed(file, lookup);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("must contain a JSON object");
    expect(diagnostics[0]?.message).not.toContain("mx.tags");
  });
});

describe("the real scan against the real policy", () => {
  it("drops the real scan's twin of the real policy diagnostic", () => {
    clearManifestCache();
    const file = project('{ "name": "a", mx: }');
    const { diagnostics } = resolveTargetPolicyDetailed(file, lookup);
    const scan = scanCustomTags(file, { targets: lookup });
    // The scan really produced the manifest-parse diagnostic ...
    const twins = scan.diagnostics.filter(
      (diagnostic) => diagnostic.code === "MX_IGNORED_CONFIG",
    );
    expect(twins).toHaveLength(1);
    expect(twins[0]?.message).toContain(
      "no `mx.tags` or `mx.contracts` are loaded until the manifest parses",
    );
    // ... and the filter, fed both real outputs, drops exactly it: the two
    // texts are built from the one shared `manifest-parse-text.ts`, so this
    // cannot drift apart when one side is reworded.
    expect(
      scanDiagnosticsNotSaidByPolicy(diagnostics, scan.diagnostics),
    ).toEqual(scan.diagnostics.filter((diagnostic) => diagnostic !== twins[0]));
  });
});
