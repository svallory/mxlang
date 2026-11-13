import type { AttrTag as CoreAttrTag } from "@mxlang/core";
import type { ComponentChildren } from "preact";
import { expectTypeOf, it } from "vitest";
import type { AttrTag } from "./index.ts";

it("adds Preact children as content unless the occurrence declares one", () => {
  expectTypeOf<AttrTag<{ title: string }>>().toEqualTypeOf<
    CoreAttrTag<{ title: string } & { content?: ComponentChildren }>
  >();
  expectTypeOf<AttrTag<{ title: string }>["content"]>().toEqualTypeOf<
    ComponentChildren | undefined
  >();
  expectTypeOf<
    AttrTag<{ content: (id: number) => ComponentChildren }>
  >().toEqualTypeOf<
    CoreAttrTag<{ content: (id: number) => ComponentChildren }>
  >();
});
