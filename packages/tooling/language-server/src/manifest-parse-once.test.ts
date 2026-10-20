import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { clearScanCache, type ScanDiagnostic } from "@mxlang/core";
import { builtinLookup, resolveTargetPolicyDetailed } from "@mxlang/targets";
import { afterAll, describe, expect, it } from "vitest";
import { diagnoseDocument } from "./diagnose.ts";

/**
 * One problem, one message: a `package.json` that fails to parse used to
 * surface twice in the language server — the host policy's positioned
 * diagnostic and the scan's `MX_IGNORED_CONFIG` at 1:1. The scan twin is
 * dropped when the policy already says it, and the policy message carries
 * the scan's consequence, so nothing is lost. The golden row
 * `bad-package-json` (tsc) pins the same end to end; these tests pin the
 * server's own behaviour and the wording edges the golden cannot reach
 * (a previous valid manifest, an unaffected project).
 */

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function project(manifest: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mx-ls-manifest-once-"));
  dirs.push(dir);
  if (manifest !== "") writeFileSync(join(dir, "package.json"), manifest);
  return join(dir, "page.mx");
}

/** What the server does for `page`: resolve the policy, hand both halves in. */
function diagnose(page: string): ReturnType<typeof diagnoseDocument> {
  const { policy, diagnostics } = resolveTargetPolicyDetailed(page);
  return diagnoseDocument(
    "<div>ok</div>\n",
    pathToFileURL(page).href,
    policy,
    undefined,
    "mx",
    undefined,
    undefined,
    undefined,
    diagnostics as ScanDiagnostic[],
  );
}

describe("manifest-parse warning appears once", () => {
  it("a broken package.json yields exactly one diagnostic, positioned, with the consequence", () => {
    clearScanCache();
    const page = project('{ "name": "a", mx: }');
    const diagnostics = diagnose(page);
    const about = diagnostics.filter((d) =>
      String(d.message).includes("could not be parsed as JSON"),
    );
    expect(about).toHaveLength(1);
    expect(about[0]?.code).toBeUndefined();
    expect(about[0]?.message).toContain(
      "no `mx.tags` or `mx.contracts` are loaded until the manifest parses",
    );
  });

  it("a previously valid manifest says the previous mx.tags stay in force", () => {
    clearScanCache();
    const page = project('{ "name": "a" }');
    diagnose(page);
    writeFileSync(join(page, "..", "package.json"), '{ "name": "a", mx: }');
    const about = diagnose(page).filter((d) =>
      String(d.message).includes("could not be parsed as JSON"),
    );
    expect(about).toHaveLength(1);
    expect(about[0]?.message).toContain(
      "the previous valid `mx.tags` and `mx.contracts` stay in force",
    );
  });

  it("a valid package.json yields no manifest diagnostics", () => {
    clearScanCache();
    const page = project('{ "name": "a", "mx": { "strict": false } }');
    const diagnostics = diagnose(page);
    expect(
      diagnostics.filter((d) => String(d.message).includes("package.json")),
    ).toEqual([]);
  });
});
