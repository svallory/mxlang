/**
 * Every error of a file is a positioned diagnostic, and no input makes
 * `parseData` throw. Measured before this change: Marko's `CompileErrors`
 * aggregate (several parse errors) and an internal span invariant escaped as
 * raw throws, and the build, the structural reject and `unknownTags` each
 * reported only the first hit.
 */

import type { CustomTag } from "@mxlang/core";
import { describe, expect, it } from "vitest";
import { type ParseDataOptions, parseData } from "./parse.ts";

const customTags: Record<string, CustomTag> = { a: {} };

/** `[line, column]` of every diagnostic, in order. */
function positions(source: string, options?: ParseDataOptions) {
  const { diagnostics } = parseData(source, "/t.mx", options);
  return diagnostics.map((d) => [d.line, d.column]);
}

describe("every error is reported", () => {
  it("returns every syntax error Marko's parser recovers from", () => {
    const { tree, diagnostics } = parseData(
      `<a x=\${y}/><!-- c\n<b x=(\n`,
      "/t.mx",
    );
    expect(tree).toBeUndefined();
    expect(diagnostics).toEqual([
      {
        severity: "error",
        message: "Expected a single expression, but found `{` after it.",
        line: 1,
        column: 6,
        offset: 6,
      },
      {
        severity: "error",
        message: "EOF reached while parsing comment",
        line: 1,
        column: 11,
        offset: 11,
      },
    ]);
  });

  it("returns every build reject, in file order", () => {
    const { tree, diagnostics } = parseData(
      `<\${x}/>\n<\${y}/>\n<a/>\n<!doctype html>\n`,
      "/t.mx",
    );
    expect(tree).toBeUndefined();
    expect(diagnostics.map((d) => [d.line, d.column, d.offset])).toEqual([
      [1, 0, 0],
      [2, 0, 8],
      [4, 0, 21],
    ]);
    expect(diagnostics.map((d) => d.message.slice(0, 13))).toEqual([
      "a dynamic tag",
      "a dynamic tag",
      "`<!doctype>` ",
    ]);
  });

  it("returns a reject in every sibling and inside every parent", () => {
    expect(
      positions(`<a/x/>\n<b>\n  <\${y}/>\n  <c/z/>\n</b>\n<d.k class='m'/>\n`),
    ).toEqual([
      [1, 0],
      [3, 2],
      [4, 2],
      [6, 0],
    ]);
  });

  it("returns every structural construct under structural: reject", () => {
    const source = `import a from 'b'\n<a>hi</a>\n\${x}\n<!-- c -->\n<if=x><b/></if>\n<for|i| of=l><c/></for>\n<const/y=1/>\nexport const z = 1\n`;
    const { diagnostics } = parseData(source, "/t.mx", {
      structural: "reject",
    });
    expect(diagnostics.map((d) => [d.line, d.column])).toEqual([
      [1, 0],
      [2, 3],
      [3, 0],
      [4, 0],
      [5, 0],
      [6, 0],
      [7, 0],
      [8, 0],
    ]);
    expect(diagnostics[0]?.message).toBe(
      "the data tree is static; this file's consumer does not evaluate `import`",
    );
  });

  it("returns every unknown tag, one per unknown call (an unknown tag's body is not walked)", () => {
    expect(
      positions("<foo/>\n<bar/>\n<baz><qux/></baz>\n", {
        unknownTags: "reject",
        customTags,
      }),
    ).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
  });

  it("merges build, structural and unknown-tag errors by position", () => {
    const { diagnostics } = parseData(
      `<\${x}/>\n<foo/>\n<a>hi</a>\n<a/>\n`,
      "/t.mx",
      { structural: "reject", unknownTags: "reject", customTags },
    );
    expect(diagnostics.map((d) => [d.line, d.column])).toEqual([
      [1, 0],
      [2, 0],
      [3, 3],
    ]);
    expect(diagnostics[0]?.message).toMatch(/^a dynamic tag/);
    expect(diagnostics[1]?.message).toMatch(/^`<foo>` is not a known tag/);
    expect(diagnostics[2]?.message).toMatch(/^the data tree is static/);
  });

  it("lists the unknown tags beside a core lowering error", () => {
    const diagnostics = parseData("<foo/>\n<if(x)></if>\n<bar/>\n", "/t.mx", {
      unknownTags: "reject",
      customTags,
    }).diagnostics;
    expect(diagnostics.map((d) => [d.line, d.column])).toEqual([
      [1, 0],
      [2, 4],
      [3, 0],
    ]);
    expect(diagnostics[1]?.message).toContain("tag arguments");
  });

  it("reports one error once, even when two walks find it", () => {
    const { diagnostics } = parseData("<a/z/>\n", "/t.mx", {
      structural: "reject",
      unknownTags: "reject",
      customTags: {},
    });
    const keys = diagnostics.map((d) => `${d.line}:${d.column}:${d.message}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not add an internal error for the tag a merged class rejects", () => {
    const { diagnostics } = parseData('<x.a class="b"/>\n<y/z/>\n', "/t.mx");
    expect(diagnostics.map((d) => [d.line, d.column])).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(diagnostics.some((d) => d.message.startsWith("internal"))).toBe(
      false,
    );
  });
});

describe("no input makes parseData throw", () => {
  const OPTIONS: (ParseDataOptions | undefined)[] = [
    undefined,
    { structural: "reject" },
    { unknownTags: "reject", customTags: {} },
    { defaultTag: "nope" },
  ];
  // Inputs that threw before: Marko's `CompileErrors` aggregate, and sources
  // whose lowering leaves a node without a span.
  const FORMER_THROWS = [
    `<a x=\${y}/><!-- c\n`,
    "}</a>}",
    `<a x:y=1/><a x=\${y}/><a <b/>/>`,
    "'<a/[x]/><a  /><a x=(#",
    "<a x=1 x=2 x=3/><a x:=1/>",
    `x<a x=\`\${<a>`,
    `:x<a x=\`\${<a></a>`,
  ];

  for (const source of FORMER_THROWS) {
    it(`returns diagnostics for ${JSON.stringify(source)}`, () => {
      for (const options of OPTIONS) {
        const result = parseData(source, "/t.mx", options);
        const errors = result.diagnostics.filter((d) => d.severity === "error");
        if (result.tree) expect(errors).toEqual([]);
        else expect(errors.length).toBeGreaterThan(0);
        for (const d of result.diagnostics) {
          expect(d.line).toBeGreaterThanOrEqual(1);
          expect(d.column).toBeGreaterThanOrEqual(0);
          expect(d.offset).toBeGreaterThanOrEqual(0);
        }
      }
    });
  }

  it("flattens a Marko aggregate that has no position of its own", () => {
    const { diagnostics } = parseData(`<a x=\${y}/><!-- c\n`, "/t.mx");
    expect(diagnostics.length).toBeGreaterThanOrEqual(2);
    expect(diagnostics.every((d) => d.line >= 1)).toBe(true);
  });

  it("reports an internal invariant at the file start under a distinct prefix", () => {
    const { tree, diagnostics } = parseData(`x<a x=\`\${<a>`, "/t.mx");
    expect(tree).toBeUndefined();
    expect(diagnostics).toEqual([
      {
        severity: "error",
        message:
          "internal error: @mxlang/data: core IR invariant broken — tag `<x>` carries no span",
        line: 1,
        column: 0,
        offset: 0,
      },
    ]);
  });

  it("keeps a source error free of the internal prefix", () => {
    const { diagnostics } = parseData("<a b=>\n", "/t.mx");
    expect(diagnostics[0]?.message).toBe("Missing value for attribute");
  });
});

describe("a clean file is unchanged", () => {
  it("returns the tree and no diagnostics", () => {
    const { tree, diagnostics } = parseData(
      '<a b="1">\n  <c d=2/>\n</a>\n',
      "/t.mx",
    );
    expect(diagnostics).toEqual([]);
    expect(tree?.children).toHaveLength(1);
  });

  it("still returns its warnings alongside the tree", () => {
    const { tree, diagnostics } = parseData("<a/>\n<b x=1 x=2/>\n", "/t.mx");
    expect(tree).toBeDefined();
    expect(diagnostics.map((d) => [d.severity, d.line, d.column])).toEqual([
      ["warning", 2, 3],
    ]);
  });

  it("is clean under every strict option", () => {
    const { tree, diagnostics } = parseData("<a b=1/>\n", "/t.mx", {
      structural: "reject",
      unknownTags: "reject",
      customTags,
    });
    expect(diagnostics).toEqual([]);
    expect(tree).toBeDefined();
  });
});
