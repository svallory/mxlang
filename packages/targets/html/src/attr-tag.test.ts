import { expectTypeOf, it } from "vitest";
import type { AttrTag } from "./index.ts";

it("types data tags as attrs plus an html render function", () => {
  expectTypeOf<
    AttrTag<{
      attrs: { title: string };
      params: [count: number];
    }>
  >().toEqualTypeOf<
    { title: string } & { content?: (count: number) => string }
  >();
});

it("types renderable tags as html render functions", () => {
  expectTypeOf<AttrTag<{ as: "renderable" }>>().toEqualTypeOf<() => string>();
  expectTypeOf<
    AttrTag<{ as: "renderable"; params: [id: number, label?: string] }>
  >().toEqualTypeOf<(id: number, label?: string) => string>();
});
