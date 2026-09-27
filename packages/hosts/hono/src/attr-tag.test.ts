import type { Child } from "hono/jsx";
import { expectTypeOf, it } from "vitest";
import type { AttrTag } from "./index.ts";

it("specialises AttrTag content to Hono children", () => {
  expectTypeOf<AttrTag<{ as: "renderable" }>>().toEqualTypeOf<Child>();
  expectTypeOf<
    AttrTag<{ attrs: { title: string } }>["content"]
  >().toEqualTypeOf<Child | undefined>();
});
