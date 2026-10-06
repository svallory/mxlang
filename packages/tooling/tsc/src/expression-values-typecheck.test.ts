import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * Expression values reach the type checker mapped: a TypeScript error inside a
 * component prop value, an attribute expression or a `${}` text expression lands
 * on the expression the author wrote, in the html target and the shared JSX
 * emitter (preact and react), including inside a nested atom (decision 156),
 * where the generated text (`"lose"`) is one character longer than the source
 * (`:lose`).
 */

const fixtures = join(import.meta.dirname, "fixtures", "expression-values");

function diagnostics(host: string): string[] {
  const project = join(fixtures, host);
  const run = runInProcess(
    ["--noEmit", "--pretty", "false", "-p", join(project, "tsconfig.json")],
    project,
  );
  expect(run.status).not.toBe(0);
  return `${run.stdout}\n${run.stderr}`
    .split("\n")
    .filter((line) => line.includes("page.mx"));
}

// page.mx, 1-based (line,column):
//   3  `<field mode="loose" modes=[:strict, :lose]/>`          `:lose`        (3,37)
//   4  `<field mode="loose" count=pick(:a, missingCount)/>`     `missingCount` (4,36)
//   5  `<input value=pick(:a, missingAttr)/>`                   `missingAttr`  (5,23)
//   6  `<p>${pick(:t, missingText)}</p>`                        `missingText`  (6,15)
//   7  `<field mode="loose" modes=["strict", 42]/>`             `42`           (7,38)
describe.each(["html", "preact", "react"])("mx-tsc on %s", (host) => {
  it("reports every expression-value error on the expression itself", () => {
    expect(diagnostics(host)).toEqual([
      expect.stringMatching(/page\.mx\(3,37\): error TS2820: .*"lose"/),
      expect.stringMatching(
        /page\.mx\(4,36\): error TS2304: Cannot find name 'missingCount'/,
      ),
      expect.stringMatching(
        /page\.mx\(5,23\): error TS2304: Cannot find name 'missingAttr'/,
      ),
      expect.stringMatching(
        /page\.mx\(6,15\): error TS2304: Cannot find name 'missingText'/,
      ),
      expect.stringMatching(/page\.mx\(7,38\): error TS2322: .*number/),
    ]);
  }, 60_000);
});
