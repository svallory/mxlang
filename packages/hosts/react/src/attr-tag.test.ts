import type { AttrTag as CoreAttrTag } from "@mxlang/core";
import type { ReactNode } from "react";
import { expectTypeOf, it } from "vitest";
import type { AttrTag } from "./index.ts";

it("adds React nodes as content unless the occurrence declares one", () => {
  expectTypeOf<AttrTag<{ title: string }>>().toEqualTypeOf<
    CoreAttrTag<{ title: string } & { content?: ReactNode }>
  >();
  expectTypeOf<AttrTag<{ title: string }>["content"]>().toEqualTypeOf<
    ReactNode | undefined
  >();
  expectTypeOf<AttrTag<{ content: (id: number) => ReactNode }>>().toEqualTypeOf<
    CoreAttrTag<{ content: (id: number) => ReactNode }>
  >();
});
