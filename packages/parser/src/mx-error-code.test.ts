import type { MxErrorCode } from "@mxlang/babel/mx-ast";
import { expect, expectTypeOf, it } from "vitest";
import * as templateCodes from "./template/util/error-code.ts";

// `@mxlang/babel` has no workspace dependency, so its `MxErrorCode` copies the
// template parser's code names as a literal union (ast §3.13). This is the one
// place that sees both lists.
type TemplateName = keyof typeof templateCodes;
type TemplateMembers = Exclude<MxErrorCode, `BABEL_${string}` | `MX_${string}`>;

it("MxErrorCode lists exactly the template parser's error codes, by name", () => {
  expectTypeOf<TemplateMembers>().toEqualTypeOf<TemplateName>();
  expect(Object.keys(templateCodes)).toHaveLength(31);
  for (const name of Object.keys(templateCodes)) {
    const member: MxErrorCode = name as TemplateName;
    expect(member).toBe(name);
  }
});

it("rejects a name the template parser does not define", () => {
  // @ts-expect-error not a template, Babel or MX code
  const bad: MxErrorCode = "NOT_A_CODE";
  expect(bad).toBe("NOT_A_CODE");
});
