// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
import { describe, expect, it } from "vitest";
import { printExpression } from "./compile.ts";
import { type Node, newCtx } from "./core.ts";
import type { Policy } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import type { Expr } from "./ir.ts";
import { lower } from "./lower.ts";
import { type GeneratedMapping, mappedExpr, mappedRewrite } from "./mapping.ts";
import { tagTable } from "./tag-table.ts";
import { lookup as targets } from "./test-targets.ts";

function rewritten(before: string, code: string): Expr {
  return {
    code,
    unrewrittenCode: before,
    shape: "other",
    node: null,
    span: { sourceStart: 100, sourceEnd: 100 + before.length },
  } as Expr;
}

const terms = (count: number, read: string) =>
  Array.from({ length: count }, (_, k) => `${read}.a${k}`).join(" + ");

/** The source offset the mappings give to the first `needle` in `code`. */
function sourceOffsetOf(
  { code, mappings }: { code: string; mappings: GeneratedMapping[] },
  needle: string,
): number | undefined {
  const at = code.indexOf(needle);
  const hit = mappings.find(
    (m) =>
      m.generatedStart <= at &&
      at + needle.length <= m.generatedEnd &&
      m.generatedEnd - m.generatedStart === m.sourceEnd - m.sourceStart,
  );
  return hit ? hit.sourceStart + (at - hit.generatedStart) : undefined;
}

describe("rewritten-read mappings", () => {
  it("keeps exact columns for a normal rewritten expression", () => {
    const result = mappedExpr(
      rewritten("i + row.name + z", "i() + row().name + z"),
    );
    expect(sourceOffsetOf(result, ".name + z")).toBe(100 + "i + row".length);
    expect(sourceOffsetOf(result, "z")).toBe(100 + "i + row.name + ".length);
  });

  it("maps a large rewritten expression fast, degrading past the cap", () => {
    const before = terms(5000, "row");
    const after = terms(5000, "row()");
    const started = performance.now();
    const { mappings } = mappedExpr(rewritten(before, after));
    expect(performance.now() - started).toBeLessThan(500);
    expect(mappings.length).toBeGreaterThan(0);
    // The unchanged tail after the last rewrite is still exact.
    const last = mappings[mappings.length - 1];
    expect(last?.generatedEnd).toBe(after.length);
    expect(last?.sourceEnd).toBe(100 + before.length);
  });

  it("stays exact below the cap on a mid-size expression", () => {
    const before = terms(100, "row");
    const after = terms(100, "row()");
    const result = mappedExpr(rewritten(before, after));
    expect(sourceOffsetOf(result, ".a77")).toBe(100 + before.indexOf(".a77"));
  });
});

describe("mappedRewrite", () => {
  it("maps reprinted text token by token", () => {
    const result = mappedRewrite("{ go(); }", "{ go() }", {
      sourceStart: 10,
      sourceEnd: 18,
    });
    expect(sourceOffsetOf(result, "go(")).toBe(12);
  });

  it("is a single mapping when nothing changed", () => {
    const { mappings } = mappedRewrite("{ a }", "{ a }", {
      sourceStart: 0,
      sourceEnd: 5,
    });
    expect(mappings).toHaveLength(1);
  });
});

describe("shorthand placeholder mappings (Expr.parts)", () => {
  const policy: Policy = {
    tags: {},
    isElement: () => true,
    isComponent: () => false,
    resolveDefaultTag: () => "input",
  };
  /** The value of the element's one shorthand attribute, lowered. */
  const shorthandValue = (
    source: string,
    generate: (node: Node) => string = printExpression,
  ): Expr => {
    const { body } = parseFragment(source, { filename: "/f/t.mx" });
    const ctx = newCtx(
      source,
      generate,
      policy,
      tagTable({ taglibs: [], tagDiscoveryDirs: [], translate: {} }, undefined),
      "/f/t.mx",
      targets,
    );
    const element = lower(ctx, body).body[0] as {
      attrs: Array<{ value: Expr }>;
    };
    return (element.attrs[0] as { value: Expr }).value;
  };

  it.each([
    // source, printed code, y's printed offset, y's source offset
    ["<div.a${y}.b/>", '[`a${y}`, "b"]', 5, 8],
    ["<div#a${y}/>", "`a${y}`", 4, 8],
    ["<div.a.${y}/>", '["a", y]', 6, 9],
    // The quasi `y` comes first in the printed code; the part is the `${y}`.
    ["<div.y${y}/>", "`y${y}`", 4, 8],
  ])("%s maps `y` one to one onto its source", (source, code, at, from) => {
    const value = shorthandValue(source);
    expect(value.code).toBe(code);
    expect(value.parts).toEqual([
      {
        span: { sourceStart: from, sourceEnd: from + 1 },
        code: { start: at, end: at + 1 },
      },
    ]);
    expect(mappedExpr(value).mappings).toContainEqual({
      sourceStart: from,
      sourceEnd: from + 1,
      generatedStart: at,
      generatedEnd: at + 1,
    });
  });

  it("maps the text around a part as a whole onto the value's span", () => {
    expect(mappedExpr(shorthandValue("<div#a${y}/>")).mappings).toEqual([
      { sourceStart: 5, sourceEnd: 10, generatedStart: 0, generatedEnd: 4 },
      { sourceStart: 8, sourceEnd: 9, generatedStart: 4, generatedEnd: 5 },
      { sourceStart: 5, sourceEnd: 10, generatedStart: 5, generatedEnd: 7 },
    ]);
  });

  it("maps a part through a reads rewrite, indexed against unrewrittenCode", () => {
    // `.${x}${y}` with both reads rewritten (`x()`, `y()`): the part ranges
    // index the text before the rewrite, and `y` moves two columns in `code`.
    const expr = {
      code: "`${x()}${y()}`",
      unrewrittenCode: "`${x}${y}`",
      shape: "string",
      node: null,
      span: { sourceStart: 5, sourceEnd: 13 },
      parts: [
        { span: { sourceStart: 7, sourceEnd: 8 }, code: { start: 3, end: 4 } },
        {
          span: { sourceStart: 11, sourceEnd: 12 },
          code: { start: 7, end: 8 },
        },
      ],
    } as Expr;
    const { mappings } = mappedExpr(expr);
    expect(mappings).toContainEqual({
      sourceStart: 7,
      sourceEnd: 8,
      generatedStart: 3,
      generatedEnd: 4,
    });
    expect(mappings).toContainEqual({
      sourceStart: 11,
      sourceEnd: 12,
      generatedStart: 9,
      generatedEnd: 10,
    });
  });

  it("keeps the whole-span mapping when a part is not found in the printed code", () => {
    // A printer that prints a lone identifier unlike the same identifier
    // inside the template: the part's text is not in the code with its
    // anchors, so no range is guessed.
    const value = shorthandValue("<div#a${y}/>", (node) =>
      node.type === "Identifier" ? `(${node.name})` : printExpression(node),
    );
    expect(value.code).toBe("`a${y}`");
    expect(value).not.toHaveProperty("parts");
    expect(mappedExpr(value).mappings).toEqual([
      { sourceStart: 5, sourceEnd: 10, generatedStart: 0, generatedEnd: 7 },
    ]);
  });
});
