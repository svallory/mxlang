/**
 * A region compile that fails still reports the callee files core read, so a
 * watcher re-runs the region when one of them changes. Core reads a callee
 * for whether a `/var` call returns a value.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compilePreactRegion } from "./index.ts";

describe("a failed region compile still reports the dependencies it read", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-preact-deps-"));
  const returning = join(dir, "ret.mx");
  writeFileSync(returning, "<return value=1/>\n");
  const caller = join(dir, "page.preact.mx");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("attaches them to an error raised after lowering", () => {
    let failure: { dependencies?: string[]; message?: string } | undefined;
    try {
      compilePreactRegion('import x from "./x"\n<Ret/y/>', {
        filename: caller,
        baseOffset: 0,
        baseLine: 0,
        baseColumn: 0,
        importSpecifiers: new Map([["Ret", "./ret.mx"]]),
        importDefaultFromMarkoOrMx: new Set(["Ret"]),
      });
    } catch (error) {
      failure = error as { dependencies?: string[]; message?: string };
    }
    expect(failure?.message).toContain("module-level MX statements");
    expect(failure?.dependencies).toEqual([returning]);
  });
});
