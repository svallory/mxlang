import { readFileSync } from "node:fs";
import type { MxErrorCode } from "@mxlang/babel/mx-ast";
import { expect, expectTypeOf, it } from "vitest";
import * as templateCodes from "./template/util/error-code.ts";

// `@mxlang/babel` has no workspace dependency, so its `MxErrorCode` copies the
// template parser's code names as a literal union (ast §3.13). This is the one
// place that sees both lists.
// `MX_`-named entries are the two language rules the template parser reports
// under their stable code (`tagShorthands: false`); the union lists them with
// the front end's `MX_*` members, not with the template names.
type TemplateName = Exclude<keyof typeof templateCodes, `MX_${string}`>;
type TemplateMembers = Exclude<MxErrorCode, `BABEL_${string}` | `MX_${string}`>;

it("MxErrorCode lists exactly the template parser's error codes, by name", () => {
  expectTypeOf<TemplateMembers>().toEqualTypeOf<TemplateName>();
  expect(Object.keys(templateCodes)).toHaveLength(35);
  for (const name of Object.keys(templateCodes)) {
    const member: MxErrorCode = name as TemplateName;
    expect(member).toBe(name);
  }
});

it("the template parser's MX_ codes are MxErrorCode members", () => {
  const mx: MxErrorCode[] = ["MX_NO_TAG_SHORTHAND", "MX_INVALID_TAG_NAME"];
  expect(Object.keys(templateCodes).filter((n) => n.startsWith("MX_"))).toEqual(
    mx,
  );
});

it("rejects a name the template parser does not define", () => {
  // @ts-expect-error not a template, Babel or MX code
  const bad: MxErrorCode = "NOT_A_CODE";
  expect(bad).toBe("NOT_A_CODE");
});

it("the two name lists are equal at runtime too", () => {
  // `@mxlang/babel` cannot import this package, so read the union's text.
  const source = readFileSync(
    new URL("../../babel/src/mx-ast.ts", import.meta.url),
    "utf-8",
  );
  const union = source.slice(source.indexOf("export type MxErrorCode"));
  const declared = [
    ...union.slice(0, union.indexOf(";\n")).matchAll(/"(\w+)"/g),
  ]
    .map((m) => m[1] ?? "")
    .filter((name) => !name.startsWith("MX_"));
  expect(declared.sort()).toEqual(
    Object.keys(templateCodes)
      .filter((name) => !name.startsWith("MX_"))
      .sort(),
  );
});
