import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * Decision 160 on Solid: a `<define>` called with attributes hands them to its
 * first param as ONE object. `|{ n }|` and `|{ n }, i|` used to fail compile
 * with "cannot close over `n`" (the capture check read the pattern's source
 * text as a name), so a clean run here proves the destructured params bind,
 * and an error inside the call's attribute still reaches the authored source.
 */

const fixtures = join(import.meta.dirname, "fixtures");

function check(project: string) {
  const dir = join(fixtures, project);
  const run = runInProcess(
    ["--noEmit", "--pretty", "false", "-p", join(dir, "tsconfig.json")],
    dir,
  );
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

describe("mx-tsc on a Solid <define> called with attributes", () => {
  it("accepts |p|, |{ n }| and |{ n }, i| calls", () => {
    const { status, output } = check("define-call-attrs-solid-clean");
    expect(output).not.toMatch(/error TS/);
    expect(output).not.toContain("cannot close over");
    expect(status).toBe(0);
  }, 60_000);

  it("reports an error in a call's attribute value on the authored expression", () => {
    const { status, output } = check("define-call-attrs-solid-failing");
    expect(status).not.toBe(0);
    // line 4: `    <Two n=missingAttr/>`: the value starts at column 12.
    expect(output).toMatch(
      /Page\.solid\.mx\(4,12\): error TS2304: Cannot find name 'missingAttr'/,
    );
  }, 60_000);
});
