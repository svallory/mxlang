import { expectTypeOf, it } from "vitest";
import type {
  AttrTag,
  AttrTagAttrs,
  AttrTagConfig,
  AttrTagOf,
  AttrTagParams,
} from "./attr-tag.ts";

type EmptyConfig = Record<never, never>;

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

it("exports helpers for a host to specialize AttrTag", () => {
  expectTypeOf<
    AttrTagParams<{ params: [id: number, label?: string] }>
  >().toEqualTypeOf<[id: number, label?: string]>();
  expectTypeOf<AttrTagParams<EmptyConfig>>().toEqualTypeOf<[]>();
  expectTypeOf<AttrTagAttrs<{ attrs: { title: string } }>>().toEqualTypeOf<{
    title: string;
  }>();
  expectTypeOf<AttrTagAttrs<EmptyConfig>>().toEqualTypeOf<EmptyConfig>();
});

it("keeps core AttrTag to one public type parameter", () => {
  // @ts-expect-error decision 106 removed the temporary Renderable parameter
  type TwoParameterAttrTag = AttrTag<EmptyConfig, string>;
  expectTypeOf<TwoParameterAttrTag>().toMatchTypeOf<unknown>();
});
