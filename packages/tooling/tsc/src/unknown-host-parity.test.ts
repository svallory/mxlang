import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseDocument } from "../../language-server/src/diagnose.ts";
import { runInProcess } from "./in-process.ts";

/**
 * An unknown `mx.host` resolves to a derived or default host. The language
 * server and `mx-tsc` must compile an `.mx` page under that same host, so
 * they report the same compile error at the same position.
 */
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true });
});

// `@mxlang/core` is the language server's dependency, not this package's:
// resolve it from the server so both sides use the copy the server runs.
const lsRequire = createRequire(
  join(import.meta.dirname, "../../language-server/package.json"),
);
const { resolveHostPolicyDetailed } = (await import(
  pathToFileURL(lsRequire.resolve("@mxlang/core")).href
)) as {
  resolveHostPolicyDetailed(file: string): {
    policy: Parameters<typeof diagnoseDocument>[2];
    diagnostics: NonNullable<
      Parameters<typeof diagnoseDocument>[8]
    > extends readonly (infer D)[]
      ? D[]
      : never;
  };
};

const fixtures = join(import.meta.dirname, "fixtures");

describe("unknown mx.host: language server and mx-tsc agree", () => {
  it("report the same compile error, message and position, for an .mx page", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-unknown-host-")));
    created.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "tmp", mx: { host: "vue" } }),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      readFileSync(join(fixtures, "ng-mx-passing", "tsconfig.json"), "utf8"),
    );
    mkdirSync(join(dir, "src"));
    const page = join(dir, "src", "page.mx");
    const source = "<div>\n  <p>hi</p>\n";
    writeFileSync(page, source);
    writeFileSync(
      join(dir, "src", "main.ts"),
      'import render from "./page.mx";\nconsole.log(render({}));\n',
    );

    const { policy, diagnostics: policyDiagnostics } =
      resolveHostPolicyDetailed(page);
    const ls = diagnoseDocument(
      source,
      pathToFileURL(page).href,
      policy,
      undefined,
      "",
      undefined,
      undefined,
      undefined,
      policyDiagnostics,
    );
    const lsError = ls.find((d) => d.severity === 1);

    const run = runInProcess(["--noEmit", "-p", "tsconfig.json"], dir);
    const tsc = { stdout: run.stdout + run.stderr };

    // Same position: LS is 0-based, mx-tsc prints `page.mx(line,col)`.
    expect(lsError).toBeDefined();
    const start = lsError?.range.start;
    const at = `page.mx(${(start?.line ?? -1) + 1},${(start?.character ?? -1) + 1})`;
    const tscLine = tsc.stdout.split("\n").find((l) => l.includes(at));
    expect(tscLine, tsc.stdout).toContain("error TS80001");

    // Same message: both carry the compiler's code frame (the part after the
    // leading `at <path>:<line>:<col>` line, whose path form differs).
    const frame = (text: string) => text.slice(text.indexOf("> 1 |"));
    const lsFrame = frame(String(lsError?.message ?? ""));
    expect(lsFrame).toContain('Missing ending "div" tag');
    expect(frame(tsc.stdout)).toContain(lsFrame.trimEnd());
  });
});
