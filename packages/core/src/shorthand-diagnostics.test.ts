import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { Policy } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import { shorthandDiagnostic } from "./shorthand-diagnostics.ts";

/**
 * Decision 174: the class/id shorthand keeps its rules, but the spellings that
 * silently compile to the wrong class — or die in Marko's parser with its own
 * vocabulary — are positioned errors with the `class="…"` hint, on every
 * target (the check runs in core's parse funnel, before Marko parses).
 *
 * `.hover:bg-red` stays valid name sugar (decision 146) with no diagnostic.
 */

const POLICY: Policy = {
  tags: {},
  isElement: () => true,
  isComponent: (name, ctx) => ctx.defines.has(name),
  resolveDefaultTag: () => "input",
};

function compileErrorOf(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    compileSource(source, "test.mx", POLICY, {
      // biome-ignore lint/suspicious/noExplicitAny: a minimal host for the parse funnel
    } as any);
  } catch (error) {
    const { message, line, column } = error as {
      message: string;
      line: number;
      column: number;
    };
    return { message, line, column };
  }
  throw new Error(`expected ${JSON.stringify(source)} to fail`);
}

function fragmentErrorOf(source: string): {
  message: string;
  line: number;
  column: number;
} {
  try {
    parseFragment(source);
  } catch (error) {
    const { message, line, column } = error as {
      message: string;
      line: number;
      column: number;
    };
    return { message, line, column };
  }
  throw new Error(`expected ${JSON.stringify(source)} to fail`);
}

describe("shorthand class diagnostics (decision 174)", () => {
  it.each([
    // An unbalanced `[` in a part: today silently `class="bg-[" id="fff]"`.
    [
      "<div.bg-[#fff]/>",
      1,
      4,
      '`.bg-[` is not a valid shorthand class: a shorthand part cannot contain `[` or `]` (write the class as `class="…"`)',
    ],
    // The bracket spellings that die in Marko's parser today.
    ["<div.w-[calc(100%-2rem)]/>", 1, 4],
    ["<div.bg-[url('/x.png')]/>", 1, 4],
    ["<div.data-[state=open]:flex/>", 1, 4],
    ["<div.[&>*]:p-4/>", 1, 4],
    // A class part starting with a digit: today silently `class="w-1 5"`.
    [
      "<div.w-1.5/>",
      1,
      8,
      '`.5` is not a valid shorthand class: a numeric part splits off what precedes it (`.w-1.5` gives `class="w-1 5"`); write the class as `class="…"`',
    ],
    // `/` after a shorthand followed by a non-identifier: today Marko's
    // tag-variable message with a link to the Marko docs.
    [
      "<div.w-1/2/>",
      1,
      8,
      '`.w-1/2` cannot be written as class shorthand: the `/` after the shorthand starts a tag variable, and `2` is not one; write the class as `class="w-1/2"`',
    ],
    // The second part on a later line, and a later tag, are positioned there.
    ["<div.a\n  .w-1.5/>", 2, 6],
    ["<div.a/>\n<div .bg-[#fff]>x</div>", 2, 5],
  ])("%j is a positioned error", (source, line, column, message?) => {
    const error = compileErrorOf(source as string);
    expect([error.line, error.column]).toEqual([line, column]);
    if (message !== undefined) expect(error.message).toBe(message);
  });

  it("parseFragment carries the same diagnostics with the fragment's base position", () => {
    const error = fragmentErrorOf("<div.bg-[#fff]/>");
    expect(error.message).toBe(
      '`.bg-[` is not a valid shorthand class: a shorthand part cannot contain `[` or `]` (write the class as `class="…"`)',
    );
    expect([error.line, error.column]).toEqual([1, 4]);
    // The region path: the same source inside a file at 10:8 throws, so the
    // AST is never returned.
    expect(() =>
      parseFragment("<div.bg-[#fff]/>", {
        filename: "f.tsx",
        baseOffset: 100,
        baseLine: 9,
        baseColumn: 7,
      }),
    ).toThrowError();
  });

  it("the fragment's shifted error lands on the region, not the fragment", () => {
    expect(() =>
      parseFragment("<div.w-1.5/>", {
        filename: "f.tsx",
        baseOffset: 50,
        baseLine: 4,
        baseColumn: 6,
      }),
    ).toThrowError(expect.objectContaining({ line: 5, column: 14 }));
  });

  it.each([
    "<div.hover:bg-red/>",
    "<div.a.b#c/>",
    "<div.w-1/>",
    // A digit-start part that is a name stays valid (decision 174 scopes the
    // numeric diagnostic to the silent split).
    "<div.2xl/>",
    "<div.a/b>",
    "<div.a/>",
    "<div.a>b</div>",
  ])("%j stays valid (no diagnostic)", (source) => {
    expect(shorthandDiagnostic(source as string)).toBeUndefined();
  });
});

describe("attribute-position shorthand diagnostics", () => {
  // The events scan cannot see attribute-position sugar (`<div .y>`), so the
  // checks live in the sugar rewrite (`name-sugar.ts`) and surface through the
  // same compile funnel.
  it.each([
    ["<div .bg-[#fff]>x</div>", 1, 5],
    ["<div .w-1.5>x</div>", 1, 9],
  ])("%j is a positioned error", (source, line, column) => {
    const error = compileErrorOf(source as string);
    expect([error.line, error.column]).toEqual([line, column]);
    expect(error.message).toContain('write the class as `class="…"');
  });
});
