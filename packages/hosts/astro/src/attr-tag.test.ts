import { expectTypeOf, it } from "vitest";
import type { AttrTag } from "./index.ts";

it("specializes data and renderable attribute tags to Astro slot thunks", () => {
  expectTypeOf<AttrTag["content"]>().toEqualTypeOf<
    (() => string) | undefined
  >();
  expectTypeOf<AttrTag<{ as: "renderable" }>>().toEqualTypeOf<() => string>();
});
