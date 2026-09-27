import type { ComponentChildren } from "preact";
import { expectTypeOf, it } from "vitest";
import type { AttrTag } from "./index.ts";

it("specialises AttrTag content to Preact children", () => {
  expectTypeOf<
    AttrTag<{ as: "renderable" }>
  >().toEqualTypeOf<ComponentChildren>();
  expectTypeOf<
    AttrTag<{ attrs: { title: string }; params: [id: number] }>["content"]
  >().toEqualTypeOf<((id: number) => ComponentChildren) | undefined>();
});
