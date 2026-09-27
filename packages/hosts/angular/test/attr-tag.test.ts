import { expectTypeOf, it } from "vitest";
import type { AttrTag } from "../src/index.ts";

it("marks Angular attribute tags as projections rather than values", () => {
  expectTypeOf<AttrTag>().toEqualTypeOf<never>();
  expectTypeOf<AttrTag<{ as: "renderable" }>>().toEqualTypeOf<never>();
});
