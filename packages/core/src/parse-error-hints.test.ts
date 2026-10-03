import { describe, expect, it } from "vitest";
import { declaredName, hintParseError } from "./parse-error-hints.ts";

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

describe("declaredName", () => {
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
    expect(declaredName(statement)).toBe(expected);
  });
});
