// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MX fixture source uses `${...}` placeholders.

import type { AttrTag as CoreAttrTag } from "@mxlang/core";
import type { ComponentChildren } from "preact";
import { expect, expectTypeOf, it } from "vitest";
import { type AttrTag, compilePreactMx } from "./index.ts";

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

it("gives nested attribute-tag loops distinct `__mxAttrIndex<n>` names", () => {
  // The outer index is named before its body is emitted, so the inner loop
  // (named while that body is emitted) takes the next serial and its key
  // still reads the outer one.
  const code = compilePreactMx(
    'import Card from "./card.mx"\n<Card><for|a| of=input.as><for|b| of=a><@item>${b}</@item></for></for></Card>',
    "/fixtures/test.mx",
  ).code;
  expect(code).toContain(
    "for (const [__mxAttrIndex0, a] of ((__mxList3) => __mxList3 ? [...__mxList3] : [])(input.as).entries()) { for (const [__mxAttrIndex1, b] of ((__mxList2) => __mxList2 ? [...__mxList2] : [])(a).entries()) { ",
  );
  expect(code).toContain(
    'key={"" + "0" + ":" + __mxAttrIndex0 + ":" + "0" + ":" + __mxAttrIndex1 + ":" + "0"}',
  );
});
