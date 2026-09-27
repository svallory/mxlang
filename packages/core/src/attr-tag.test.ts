import { expectTypeOf, it } from "vitest";
import type { AttrTag, AttrTagConfig, AttrTagOf } from "./attr-tag.ts";

it("types data attribute tags as attrs plus optional content", () => {
  type Value = AttrTagOf<
    { attrs: { title: string }; params: [count: number] },
    string
  >;
  expectTypeOf<Value>().toEqualTypeOf<
    { title: string } & { content?: (count: number) => string }
  >();
});

it("types renderable attribute tags as a renderable or render function", () => {
  expectTypeOf<
    AttrTagOf<{ as: "renderable" }, string>
  >().toEqualTypeOf<string>();
  expectTypeOf<
    AttrTagOf<{ as: "renderable"; params: [id: number] }, string>
  >().toEqualTypeOf<(id: number) => string>();
});

it("exports the generic core AttrTag and its config constraint", () => {
  expectTypeOf<AttrTag<{ attrs: { id: number } }>>().toEqualTypeOf<
    { id: number } & { content?: unknown }
  >();
  expectTypeOf<{
    as: "data";
    attrs: object;
    params: readonly unknown[];
  }>().toMatchTypeOf<AttrTagConfig>();
});
