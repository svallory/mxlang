import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

// Decision 169: core refuses a modifier on a bound attribute at its colon, with
// the same text on every target (Marko reads `v:fn:=q` as a bound `v` with a
// change handler `q = fn(next)`, which MX does not lower).
describe("a modifier on a bound attribute (preact)", () => {
  it.each([
    ["<div v:fn:=q/>", 1, 6],
    ["<div is:raw:=x/>", 1, 7],
    ["<div a=1\n  v:fn:=q/>", 2, 3],
  ])("is one positioned error at the colon: %j", (source, line, column) => {
    let error: { message: string; line: number; column: number } | undefined;
    try {
      compilePreactMx(source, "x.mx");
    } catch (e) {
      error = e as typeof error;
    }
    expect(error).toMatchObject({ line, column });
    expect(error?.message).toContain(
      "A bound attribute name cannot contain `:`",
    );
    expect(error?.message).toContain("Change(next) {");
  });
});

// Every place a bound attribute can appear, not only a native element: a
// dynamic tag, a contracted custom-tag call and its attribute tags, and an
// empty modifier (`x::=q`).
const card: Record<string, CustomTag> = {
  card: {
    attributes: { v: { type: "string" } },
    attributeTags: { row: { attributes: { v: { type: "string" } } } },
    transform: () => [],
  },
};

describe("a modifier on a bound attribute, wherever it appears (preact)", () => {
  it.each([
    ["<${t} v:fn:=q/>", 1, 7, "`:fn`"],
    ["<div x::=q/>", 1, 6, "empty modifier"],
    ["<card v:fn:=q/>", 1, 7, "`:fn`"],
    ["<card><@row v:fn:=q/></card>", 1, 13, "`:fn`"],
  ])("is one positioned error: %j", (source, line, column, drops) => {
    let error: { message: string; line: number; column: number } | undefined;
    try {
      compilePreactMx(source, "x.mx", { customTags: card });
    } catch (e) {
      error = e as typeof error;
    }
    expect(error).toMatchObject({ line, column });
    expect(error?.message).toContain(
      "A bound attribute name cannot contain `:`",
    );
    expect(error?.message).toContain(drops);
    expect(error?.message).not.toContain("v:=q");
  });
});
