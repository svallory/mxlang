import { describe, expect, it } from "vitest";
import { lowerAstroMx } from "./astro-template.ts";

// The template starts on line 4, after a three-line fence.
const FENCE = "---\nconst x = 1;\n---\n";

// `.astro.mx` renders static markup, so `:=` is a positioned error. A refined
// form (`v:fn:=q`) gets the same error at the same place, never a silent drop.
function failure(source: string) {
  try {
    lowerAstroMx(`${FENCE}${source}`, "Test.astro.mx");
  } catch (e) {
    return e as { message: string; line: number; column: number };
  }
  throw new Error("expected an error");
}

describe("a refined bound attribute (astro)", () => {
  it.each([
    ["<div v:fn:=q/>", "<div v:=q/>", 4, 5],
    ["<div is:raw:=x/>", "<div is:=x/>", 4, 5],
    ["<div a=1\n  v:fn:=q/>", "<div a=1\n  v:=q/>", 5, 2],
  ])(
    "is the host's `:=` error on the attribute: %j",
    (refined, plain, line, column) => {
      const error = failure(refined);
      expect(error).toMatchObject({ line, column });
      expect(error.message).toContain("two-way binding");
      expect(failure(plain)).toMatchObject({ line, column });
    },
  );
});
