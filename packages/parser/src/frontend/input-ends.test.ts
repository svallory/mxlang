// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MX source with ${…} placeholders
/**
 * `MX_INPUT_ENDS_IN_DELIMITER` (decision 161: no silent drop). At end of
 * input inside a concise open delimiter the template parser (like stock
 * htmljs-parser 5.18.0) stops with no error and no close events; the front
 * end reports the outermost delimiter left open, spanning its opener, and
 * keeps the tree with the open tags closed. The corpus probes are in
 * `corpus.test.ts`; these pin the text.
 */
import { describe, expect, it } from "vitest";
import { parse } from "./parse.ts";
import { checkInvariants } from "./test-support/invariants.ts";
import { OPTIONS } from "./test-support/options.ts";

function errorsOf(
  source: string,
  base?: { offset: number; line: number; column: number },
) {
  const document = parse(source, { ...OPTIONS, ...(base ? { base } : {}) });
  expect(checkInvariants(document, OPTIONS.tagShape)).toEqual([]);
  return document.errors.map((e) => ({
    code: e.code,
    origin: e.origin,
    start: e.start,
    end: e.end,
    message: e.message,
  }));
}

const ends = (start: number, end: number, open: string, close: string) => [
  {
    code: "MX_INPUT_ENDS_IN_DELIMITER",
    origin: "front-end",
    start,
    end,
    message: `the input ends inside ${open}…${close} opened here`,
  },
];

describe("input ending inside a concise open delimiter", () => {
  it.each([
    ["div(a", 3, 4, "`(`", "`)`"],
    ["div|a", 3, 4, "`|`", "`|`"],
    ["x<a", 1, 2, "`<`", "`>`"],
    ["x<a x=`${<a>", 1, 2, "`<`", "`>`"],
    ["div onClick(a) {b", 15, 16, "`{`", "`}`"],
    ["div x(a", 5, 6, "`(`", "`)`"],
    ["div/a(", 5, 6, "`(`", "`)`"],
    ["div\n  span<a", 10, 11, "`<`", "`>`"],
    ["div x=`${a", 6, 7, "`` ` ``", "`` ` ``"],
    ["div.a${b", 5, 7, "`${`", "`}`"],
    ["script -- ${b", 10, 12, "`${`", "`}`"],
    ["$ {a", 2, 3, "`{`", "`}`"],
    ["${x", 0, 2, "`${`", "`}`"],
  ])("%j reports its opener", (source, start, end, open, close) => {
    expect(errorsOf(source)).toEqual(ends(start, end, open, close));
  });

  it("keeps the tree: the cut tag and what the parser reported", () => {
    const document = parse("div(a", OPTIONS);
    expect(document.complete).toBe(true);
    expect(document.body).toHaveLength(1);
    expect(document.body[0]).toMatchObject({ type: "MxTag", start: 0 });
  });

  it("positions the opener in file offsets under a base", () => {
    expect(errorsOf("x<a", { offset: 10, line: 2, column: 4 })).toEqual(
      ends(11, 12, "`<`", "`>`"),
    );
  });

  it.each([
    "div(a)",
    "div|a|",
    "div -- (a",
    "<div(a)/>",
    "div\n  -- ${a}\n",
    "// c (",
    "<div/>\n",
  ])("%j, closed or plain text, reports nothing", (source) => {
    expect(errorsOf(source)).toEqual([]);
  });

  it("a template error at end of input is the template parser's alone", () => {
    expect(errorsOf("div x=(a").map((e) => e.code)).toEqual([
      "MALFORMED_OPEN_TAG",
    ]);
  });
});
