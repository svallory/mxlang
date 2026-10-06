import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInProcess } from "./in-process.ts";

/**
 * A TypeScript error in a Solid page reaches `mx-tsc` on the authored source.
 * Before this, a whole-file `.mx` resolved to Solid reported nothing at all
 * (exit 0, even for an undeclared name): the Solid emitter recorded no
 * mappings for values, and the plugin does not re-lower a host that records
 * its own, so every diagnostic landed on unmapped generated text and was
 * dropped. A `.solid.mx` region reported only the plain value; an expression
 * containing an atom (decision 156, one character longer in generated text)
 * was lost.
 */

const fixtures = join(import.meta.dirname, "fixtures", "expression-values");

function check(project: string, file: string) {
  const run = runInProcess(
    [
      "--noEmit",
      "--pretty",
      "false",
      "-p",
      join(fixtures, project, "tsconfig.json"),
    ],
    join(fixtures, project),
  );
  const lines = `${run.stdout}\n${run.stderr}`
    .split("\n")
    .filter((line) => line.includes(file));
  return { status: run.status, lines };
}

// whole-file page.mx, 1-based (line,column):
//   3  `<field mode="loose" modes=[:strict, :lose]/>`          `:lose`        (3,37)
//   4  `<field mode="loose" count=pick(:a, missingCount)/>`     `missingCount` (4,36)
//   5  `<input value=pick(:a, missingAttr)/>`                   `missingAttr`  (5,23)
//   6  `<p>${pick(:t, missingText)}</p>`                        `missingText`  (6,15)
//   7  `<field mode="loose" modes=["strict", 42]/>`             `42`           (7,38)
describe("mx-tsc on a Solid page", () => {
  it("whole-file .mx reports every expression-value error on the expression", () => {
    const { status, lines } = check("solid", "page.mx");
    expect(status).not.toBe(0);
    expect(lines).toEqual([
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

  // A region reaches the checker through the parser's text-match remapping,
  // which finds an expression only when its generated text is verbatim: plain
  // values report (pinned here), an expression containing an atom does not
  // (TODO `solid-region-atom-values-unmapped`, every region host).
  it(".solid.mx region reports plain expression-value errors on the expression", () => {
    const { status, lines } = check("solid-region", "Page.solid.mx");
    expect(status).not.toBe(0);
    expect(lines).toEqual([
      expect.stringMatching(
        /Page\.solid\.mx\(5,31\): error TS2304: Cannot find name 'missingCount'/,
      ),
      expect.stringMatching(
        /Page\.solid\.mx\(6,18\): error TS2304: Cannot find name 'missingAttr'/,
      ),
      expect.stringMatching(
        /Page\.solid\.mx\(7,10\): error TS2304: Cannot find name 'missingText'/,
      ),
      expect.stringMatching(/Page\.solid\.mx\(8,42\): error TS2322: .*number/),
    ]);
  }, 60_000);

  it("whole-file .mx maps module-level statements, not only the template", () => {
    const { status, lines } = check("solid-module", "page.mx");
    expect(status).not.toBe(0);
    expect(lines).toEqual([
      expect.stringMatching(/page\.mx\(1,22\): error TS2307: /),
      expect.stringMatching(/page\.mx\(2,14\): error TS2322: .*string.*number/),
      expect.stringMatching(
        /page\.mx\(3,29\): error TS2304: Cannot find name 'Missing'/,
      ),
    ]);
  }, 60_000);

  it("a clean whole-file page stays clean", () => {
    const { status, lines } = check("solid-clean", "page.mx");
    expect(lines).toEqual([]);
    expect(status).toBe(0);
  }, 60_000);
});
