// biome-ignore-all lint/suspicious/noTemplateCurlyInString: authored MX source
import { describe, expect, it } from "vitest";
import { lowerSource } from "./ir-entry/index.ts";

// Captured from core at 6184d363, before this branch's declaration rules.
const dataVar = (tag: string) =>
  `tag variable \`/x\` on \`<${tag}>\`: data files are static, so a binding without evaluation means nothing`;
const noTemplate =
  "`/var` on `<sort>` is not supported: it has no template, so it has no `<return>` to bind";
const dynamic =
  "tag variable `/x` on `<dynamic tag>` is not supported in a standalone template";
const at = (code: string, message: string, column: number) => ({
  code,
  message,
  line: 1,
  column,
});
const data = (tag: string, column = 0) =>
  at("MX_NOT_IN_DATA_FILE", dataVar(tag), column);
const unsupported = (column: number) =>
  at("MX_UNSUPPORTED_CONSTRUCT", dynamic, column);
const contract = (column: number) =>
  at("MX_INVALID_TAG_VAR", noTemplate, column);

const cases = [
  { source: "<const/x=x+1/>", expected: [] },
  { source: "<let/x=x/>", expected: [data("let")] },
  { source: "<foo/x a=x/>", expected: [data("foo")] },
  { source: "<sort/x a=x/>", expected: [contract(6)] },
  { source: "<${T}/x a=x/>", expected: [unsupported(6)] },
  { source: "<const/x=1/><const/x=2/>", expected: [] },
  { source: "<foo/x/><foo/x/>", expected: [data("foo"), data("foo", 8)] },
  { source: "<sort/x/><sort/x/>", expected: [contract(6), contract(15)] },
  { source: "<${T}/x/><${T}/x/>", expected: [unsupported(6), unsupported(15)] },
  { source: "<for|x| of=[1]><const/x=1/></for>", expected: [] },
  {
    source: "<define/D|x|><const/x=1/></define>",
    expected: [
      at(
        "MX_NOT_IN_DATA_FILE",
        "`<define>` is a render-time macro: data files are static, so they cannot expand it; inline the content at each use",
        0,
      ),
    ],
  },
  { source: "<const/x=() => { x = 1 }/>", expected: [] },
  {
    source: "<foo(a)><if=c><@x/>text</if></foo>",
    expected: [
      at(
        "MX_INVALID_ATTRIBUTE_TAG",
        "Cannot have attribute tags and body content under a control flow tag.",
        19,
      ),
    ],
  },
  { source: "<id/x/><id/x/>", expected: [data("id"), data("id", 7)] },
  { source: "<await|v|=p><const/v=1/></await>", expected: [] },
];
describe("tagRules none retains the pre-declaration-rules diagnostics", () => {
  it.each(cases)("$source", ({ source, expected }) => {
    const result = lowerSource(source, "/w/page.mx", {
      tagRules: "none",
      customTags: {
        sort: {
          attributes: { a: { type: "expression" } },
          transform: () => [],
        },
      },
    });
    expect(
      result.diagnostics.map(({ code, message, line, column }) => ({
        code,
        message,
        line,
        column,
      })),
    ).toEqual(expected);
  });
  it("does not pre-register a later define", () => {
    const result = lowerSource(
      "<div>${D}</div><define/D>x</define>",
      "/w/page.mx",
      { tagRules: "none" },
    );
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "MX_NOT_IN_DATA_FILE",
    ]);
  });
});

it("keeps the unsupported dynamic /var diagnostic on the html IR path", () => {
  const result = lowerSource("<${input.t}/x a=x/>", "/w/page.mx", {
    tagRules: "html",
  });
  expect(result.diagnostics[0]).toMatchObject({
    code: "MX_UNSUPPORTED_CONSTRUCT",
    message: dynamic,
  });
});
