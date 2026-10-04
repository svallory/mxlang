import { expect, it } from "vitest";
import { compile } from "./index.ts";

for (const source of ["<let/c=1 value=2/>", "<let/c=1 value:=c/>"]) {
  it(`validates the builtin before default HTML drops it: ${source}`, () => {
    let error: unknown;
    try {
      compile(source, "test.mx");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      message: "Invalid duplicate value attribute.",
      line: 1,
      column: 9,
    });
  });
}
it("hoists one native guard per module and omits unused helpers", () => {
  const code = compile(
    "<div data-x=input.a data-y=input.b data-z=input.c ...input.attrs/>",
    "test.mx",
  ).code;
  expect(code.match(/const __mxAttrValue =/g)).toHaveLength(1);
  expect(code.match(/attribute cannot be/g)).toHaveLength(2);
  expect(compile('<div data-x="x"/>', "test.mx").code).not.toContain(
    "__mxAttrValue",
  );
});
