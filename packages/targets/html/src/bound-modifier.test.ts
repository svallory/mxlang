import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";

// A bound attribute's refinement (`v:fn:=q`, Marko's `q = fn(next)` change
// handler) belongs to a target with an update path. html renders once, like
// Marko's server html, where the handler is client-only: the attribute renders
// as the unrefined `v:=q` does, byte for byte.
describe("a refined bound attribute renders like the unrefined one (html)", () => {
  it.each([
    ["<input value:fn:=q/>", "<input value:=q/>"],
    ["<div is:raw:=x/>", "<div is:=x/>"],
    ["<div data-x:fn:=q/>", "<div data-x:=q/>"],
  ])("%s", (refined, plain) => {
    const bare = compile(plain, "x.mx");
    expect(compile(refined, "x.mx").code).toBe(bare.code);
  });
});

// A refinement that is no identifier is Marko's error, at the colon, on every
// tag shape: a dynamic tag, a contracted custom-tag call and its attribute tags.
const card: Record<string, CustomTag> = {
  card: {
    attributes: { v: { type: "string" } },
    attributeTags: { row: { attributes: { v: { type: "string" } } } },
    transform: () => [],
  },
};

describe("a refinement that is no identifier, wherever it appears (html)", () => {
  it.each([
    ["<div v:no-update:=q/>", 1, 6],
    ["<div x::=q/>", 1, 6],
    ["<${t} v:no-update:=q/>", 1, 7],
    ["<card v:no-update:=q/>", 1, 7],
    ["<card><@row v:no-update:=q/></card>", 1, 13],
    ["<div a=1\n  v:no-update:=q/>", 2, 3],
  ])("is Marko's error at the colon: %j", (source, line, column) => {
    let error: { message: string; line: number; column: number } | undefined;
    try {
      compile(source, "x.mx", { customTags: card });
    } catch (e) {
      error = e as typeof error;
    }
    expect(error).toMatchObject({ line, column });
    expect(error?.message).toBe(
      "Bound attribute refinement shorthand must be a valid JavaScript identifier.",
    );
  });
});
