import type { ReactNode } from "react";
import { expectTypeOf, it } from "vitest";
import type { AttrTag } from "./index.ts";

it("specialises AttrTag content to React nodes", () => {
  expectTypeOf<AttrTag<{ as: "renderable" }>>().toEqualTypeOf<ReactNode>();
  expectTypeOf<
    AttrTag<{ attrs: { title: string } }>["content"]
  >().toEqualTypeOf<ReactNode | undefined>();
});
