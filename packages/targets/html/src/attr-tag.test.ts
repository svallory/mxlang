import type { AttrTag as CoreAttrTag } from "@mxlang/core";
import { expectTypeOf, it } from "vitest";
import type { AttrTag } from "./index.ts";

it("adds an html render function as content unless the occurrence declares one", () => {
  expectTypeOf<AttrTag>().toEqualTypeOf<
    // biome-ignore lint/complexity/noBannedTypes: an attribute tag with no attributes
    CoreAttrTag<{} & { content?: () => string }>>();
  expectTypeOf<AttrTag<{ title: string }>>().toEqualTypeOf<
    CoreAttrTag<{ title: string } & { content?: () => string }>
  >();
  expectTypeOf<
    AttrTag<{ title: string; content: (count: number) => string }>
  >().toEqualTypeOf<
    CoreAttrTag<{ title: string; content: (count: number) => string }>
  >();
});
