import { describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

// The template starts on line 4, after a three-line fence.
const FENCE = "---\nconst x = 1;\n---\n";

// Decision 169: core refuses a modifier on a bound attribute at its colon, with
// the same text on every target (Marko reads `v:fn:=q` as a bound `v` with a
// change handler `q = fn(next)`, which MX does not lower).
describe("a modifier on a bound attribute (astro)", () => {
  it.each([
    ["<div v:fn:=q/>", 1, 6],
    ["<div is:raw:=x/>", 1, 7],
    ["<div a=1\n  v:fn:=q/>", 2, 3],
  ])("is one positioned error at the colon: %j", (source, line, column) => {
    let error: { message: string; line: number; column: number } | undefined;
    try {
      lowerAstroMx(`${FENCE}${source}`, "Test.astro.mx");
    } catch (e) {
      error = e as typeof error;
    }
    expect(error).toMatchObject({ line: line + 3, column });
    expect(error?.message).toContain(
      "A bound attribute name cannot contain `:`",
    );
    expect(error?.message).toContain("Change(next) {");
  });
});
