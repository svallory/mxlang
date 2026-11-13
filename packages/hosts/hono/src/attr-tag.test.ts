import type { AttrTag as CoreAttrTag } from "@mxlang/core";
import type { Child } from "hono/jsx";
import { expectTypeOf, it } from "vitest";
import type { AttrTag } from "./index.ts";

it("adds Hono children as content unless the occurrence declares one", () => {
  expectTypeOf<AttrTag<{ title: string }>>().toEqualTypeOf<
    CoreAttrTag<{ title: string } & { content?: Child }>
  >();
  expectTypeOf<AttrTag<{ title: string }>["content"]>().toEqualTypeOf<
    Child | undefined
  >();
  expectTypeOf<AttrTag<{ content: (id: number) => Child }>>().toEqualTypeOf<
    CoreAttrTag<{ content: (id: number) => Child }>
  >();
});
