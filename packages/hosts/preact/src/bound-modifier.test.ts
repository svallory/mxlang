import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

// preact has no update path for a bound attribute, so `:=` is a positioned
// error. A refined form (`v:fn:=q`, Marko's `q = fn(next)` handler) gets the
// same error at the same place: the attribute, never a silent drop.
function failure(source: string) {
  try {
    compilePreactMx(source, "x.mx");
  } catch (e) {
    return e as { message: string; line: number; column: number };
  }
  throw new Error("expected an error");
}

describe("a refined bound attribute (preact)", () => {
  it.each([
    ["<div v:fn:=q/>", "<div v:=q/>", 1, 5],
    ["<div is:raw:=x/>", "<div is:=x/>", 1, 5],
    ["<div a=1\n  v:fn:=q/>", "<div a=1\n  v:=q/>", 2, 2],
  ])(
    "is the host's `:=` error on the attribute: %j",
    (refined, plain, line, column) => {
      const error = failure(refined);
      expect(error).toMatchObject({ line, column });
      expect(error.message).toContain("two-way binding");
      expect(error).toMatchObject({
        line: failure(plain).line,
        column: failure(plain).column,
      });
    },
  );
});
