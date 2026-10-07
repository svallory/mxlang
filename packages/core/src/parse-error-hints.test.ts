import { describe, expect, it } from "vitest";
import { declaredBinding, hintParseError } from "./parse-error-hints.ts";

const REASON = 'Unexpected token, expected "{"';

/** An error shaped like one entry of `@marko/compiler`'s aggregate. */
function entry(line: number, column: number, at: string) {
  const error = new Error(
    `\n    at ${at}\n    > ${line} | …\n        |   ^ ${REASON}`,
  ) as Error & { label: string; loc: unknown };
  error.label = REASON;
  error.loc = { start: { line, column } };
  return error;
}

function aggregate(entries: Error[]) {
  const error = new Error(entries.map((e) => e.message).join("\n")) as Error & {
    errors: Error[];
  };
  error.errors = entries;
  return error;
}

describe("hintParseError on an aggregate", () => {
  it("leaves an unhinted entry with the same reason alone and hints the right frame", () => {
    // Line 1 is not an `id= class` shape (nothing to hint); line 2 is.
    const source = '<div x>\n<div id= class="a">';
    const first = entry(1, 5, "t.mx:1:6");
    const second = entry(2, 14, "t.mx:2:15");
    const error = aggregate([first, second]);
    hintParseError(error, source);
    const frames = error.message
      .split("\n")
      .filter((line) => line.includes("^"));
    expect(frames[0]).toBe(`        |   ^ ${REASON}`);
    expect(frames[1]).toContain("`id=` has no value");
    expect(second.label).toContain("`id=` has no value");
    expect(first.label).toBe(REASON);
  });
});

describe("declaredBinding", () => {
  it.each(["const", "let", "var"])(
    "retains the %s keyword with the single variable",
    (keyword) => {
      expect(declaredBinding(`${keyword} count = f(a, b);`)).toEqual({
        name: "count",
        keyword,
      });
    },
  );

  it.each([
    ["const x = 1;", "x"],
    ["let n = f(a, b);", "n"],
    ["var s = 'a,b';", "s"],
    ["const o = { a: 1, b: 2 };", "o"],
    ["const x = 1, y = 2;", undefined],
    ["const { a, b } = x;", undefined],
    ["doThing();", undefined],
    ["x = 2;", undefined],
    ["class Foo {}", undefined],
    ['import Foo from "./Foo.mx";', undefined],
  ])("%s -> %s", (statement, expected) => {
    expect(declaredBinding(statement)?.name).toBe(expected);
  });
});

describe("decision 174: shorthand parse errors", () => {
  const TAG_VARIABLE =
    "`2` is not a valid [tag variable](https://markojs.com/docs/reference/language#tag-variables); use a JavaScript identifier or destructuring pattern.";

  function parseError(
    source: string,
    label: string,
    column: number,
    index = column,
  ) {
    const at = `t.mx:1:${column + 1}`;
    const error = new Error(
      `\n    at ${at}\n    > 1 | ${source}\n        | ${" ".repeat(column)}^ ${label}`,
    ) as Error & { label: string; loc: unknown };
    error.label = label;
    error.loc = { start: { line: 1, column, index } };
    return error;
  }

  it("a `/` before a non-identifier names the class shorthand, not the tag variable", () => {
    const source = "<div.w-1/2/>";
    const error = parseError(source, TAG_VARIABLE, 9);
    hintParseError(error, source);
    expect(error.label).toContain("`2` is not more class");
    expect(error.label).toContain('class="…"');
    expect(error.label).not.toContain("is not a valid [tag variable]");
    expect(error.message).toContain("`2` is not more class");
  });

  it("leaves a tag-variable error with no shorthand `/` alone", () => {
    const source = "<div x/2/>";
    const error = parseError(source, TAG_VARIABLE, 7);
    hintParseError(error, source);
    expect(error.label).toBe(TAG_VARIABLE);
  });

  it.each([
    [
      "<div.data-[state=open]:flex/>",
      20,
      'Mismatched group. A closing "]" character was found but it is not matched with a corresponding opening character.',
    ],
    ["<div.[&>*]:p-4/>", 0, 'Missing ending "div" tag'],
  ])(
    "%s: Marko's group text becomes the shorthand message",
    (source, column, label) => {
      const error = parseError(source, label, column);
      hintParseError(error, source);
      expect(error.label).toContain("a class or id shorthand cannot hold");
      expect(error.label).toContain('class="…"');
      expect(error.label).not.toContain("Mismatched");
      expect(error.label).not.toContain("Missing ending");
    },
  );

  it("leaves a group error with no shorthand head alone", () => {
    const source = "<div x=[1]></div>";
    const label = 'Mismatched group. A closing "]" character was found.';
    const error = parseError(source, label, 9);
    hintParseError(error, source);
    expect(error.label).toBe(label);
  });

  it("rewrites every entry of an aggregate", () => {
    const source = "<div.w-[calc(100%-2rem)]/>";
    const first = parseError(source, "Identifier directly after number.", 19);
    const second = parseError(
      source,
      'Mismatched group. A closing "]" character was found but it is not matched with a corresponding opening character.',
      23,
    );
    const aggregate = new Error(
      [first.message, second.message].join("\n"),
    ) as Error & { errors: Error[] };
    aggregate.errors = [first, second];
    hintParseError(aggregate, source);
    expect(first.label).toContain("a class or id shorthand cannot hold");
    expect(second.label).toContain("a class or id shorthand cannot hold");
    expect(aggregate.message).not.toContain("Mismatched group");
    expect(aggregate.message).not.toContain("Identifier directly after number");
  });
});
