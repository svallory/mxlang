import { describe, expect, it } from "vitest";
import { compileSolidUnit } from "./index.ts";

/**
 * A `static` statement's code is the text after the keyword, so its mapping
 * must start after the keyword. Searching from the statement start mapped
 * `static a` onto the `a` inside `static`.
 */
function mapped(source: string): Array<[number, string, string]> {
  const { code, mappings } = compileSolidUnit(source, {
    filename: "/fixtures/static.mx",
    customTags: {},
  });
  return mappings.map((m) => [
    m.sourceStart,
    source.slice(m.sourceStart, m.sourceEnd),
    code.slice(m.generatedStart, m.generatedEnd),
  ]);
}

describe("static statement mappings in a Solid unit", () => {
  // [source, code the host prints, expected source offset]
  const cases: Array<[string, string, number]> = [
    ["static a\n<div/>", "a", 7],
    ["static s\n<div/>", "s", 7],
    ["static t\n<div/>", "t", 7],
    ["static i\n<div/>", "i", 7],
    ["static c\n<div/>", "c", 7],
    ["static   a\n<div/>", "a", 9],
    ["static\ta\n<div/>", "a", 7],
    ["static { a }\n<div/>", "a", 9],
    ["static a = 1\n<div/>", "a = 1", 7],
    ["static { let a = 1 }\n<div/>", "let a = 1", 9],
    ["static const a = 1\n<div/>", "const a = 1", 7],
  ];

  it.each(cases)("maps %j after the keyword", (source, code, offset) => {
    const found = mapped(source);
    expect(found).toContainEqual([offset, code, code]);
    for (const [start] of found) {
      expect(start).toBeGreaterThanOrEqual("static".length);
    }
  });

  it("maps the second static statement, not the first one's text", () => {
    expect(
      mapped("static a\nstatic s\n<div/>").map(([start]) => start),
    ).toEqual([7, 16]);
  });
});
