import { expect, it } from "vitest";
import { compilePreactMx } from "./index.ts";

it("hoists one guard pair for attributes, nested definitions and dynamic tags", () => {
  const code = compilePreactMx(
    "<define/Card><div data-x=input.a data-y=input.b/></define><div data-z=input.c ...input.attrs/><${input.tag} data-q=input.q/>",
    "test.mx",
  ).code;
  expect(code.match(/const __mxAttrValue =/g)).toHaveLength(1);
  expect(code.match(/const __mxAttrSpread =/g)).toHaveLength(1);
  expect(code.match(/attribute cannot be/g)).toHaveLength(2);
  expect(compilePreactMx('<div data-x="x"/>', "test.mx").code).not.toContain(
    "__mxAttrValue",
  );
});
