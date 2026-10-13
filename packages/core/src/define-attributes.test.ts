// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the sources are MX, not JS templates
/**
 * A `<define>` tag's attributes are properties of its value, as in Marko
 * 6.4.4 (`<define/D a=1 b="s"/>` is `const D = { a: 1, b: "s" }`, and
 * `${D.a}` reads `1`). Before this, lowering read the define's name, params and
 * body and never its attributes: `<define/D a=(count++)/>` compiled, `${D.a}`
 * read `undefined`, and a `<let>` write in the attribute escaped the
 * render-write check.
 */
import { describe, expect, it } from "vitest";
import { printExpression } from "./compile.ts";
import { newCtx } from "./core.ts";
import type { Policy } from "./declarations.ts";
import { parseFragment } from "./fragment.ts";
import type { IrNode } from "./ir.ts";
import { lower } from "./lower.ts";
import { tagTable } from "./tag-table.ts";
import { lookup as targets } from "./test-targets.ts";

const bare = () => ({ taglibs: [], tagDiscoveryDirs: [], translate: {} });

const policy = (): Policy => ({
  tags: {},
  isElement: () => true,
  isComponent: (name, ctx) => ctx.defines.has(name) || ctx.imports.has(name),
  resolveDefaultTag: () => "input",
});

function lowerSource(source: string) {
  const { body } = parseFragment(source, { filename: "/f/t.mx" });
  const ctx = newCtx(
    source,
    printExpression,
    policy(),
    tagTable(bare(), undefined),
    "/f/t.mx",
    targets,
  );
  return lower(ctx, body);
}

type Define = Extract<IrNode, { kind: "Define" }>;

function defineOf(source: string): Define {
  const found = lowerSource(source).body.find(
    (node): node is Define => node.kind === "Define",
  );
  if (!found) throw new Error("no <define> lowered");
  return found;
}

// biome-ignore lint/suspicious/noExplicitAny: a caught TranslateError, read by field
function thrown(source: string): any {
  try {
    lowerSource(source);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("a <define> carries its attributes", () => {
  it("keeps every attribute, in source order, with its resolved kind", () => {
    const define = defineOf('<define/D a=1 b="s" c d=input.x/>');
    expect(
      define.attrs.map((attr) => [attr.kind, "name" in attr ? attr.name : ""]),
    ).toEqual([
      ["dynamic", "a"],
      ["static", "b"],
      ["boolean", "c"],
      ["dynamic", "d"],
    ]);
  });

  it("keeps a spread between attributes where it was written", () => {
    const define = defineOf("<define/D a=1 ...input.rest b=2/>");
    expect(define.attrs.map((attr) => attr.kind)).toEqual([
      "dynamic",
      "spread",
      "dynamic",
    ]);
  });

  it("keeps a bound attribute as a bound attribute", () => {
    const define = defineOf("<define/D a:=input.x/>");
    expect(define.attrs.map((attr) => attr.kind)).toEqual(["bound"]);
  });

  it("a define with no attributes has none", () => {
    expect(defineOf("<define/D><p>x</p></define>").attrs).toEqual([]);
  });

  it("a define with a body keeps both", () => {
    const define = defineOf("<define/D a=1><p>x</p></define>");
    expect(define.attrs).toHaveLength(1);
    expect(define.children.length).toBeGreaterThan(0);
  });

  it("a last-wins duplicate is one attribute, as on any tag", () => {
    const define = defineOf("<define/D a=1 a=2/>");
    expect(define.attrs).toHaveLength(1);
  });

  it("the params of the define are not in scope in its attributes", () => {
    // Marko lowers `a=x` outside the define's content function, so `x` here is
    // whatever the template has outside: it must not be rewritten as the param.
    const define = defineOf("<define/D|x| a=x><p>${x}</p></define>");
    expect(define.params).toEqual(["x"]);
    expect(define.attrs).toHaveLength(1);
  });
});

describe("`content` on a <define>", () => {
  it("is an ordinary property when the define has no body", () => {
    expect(defineOf('<define/D content="x"/>').attrs).toHaveLength(1);
    expect(defineOf('<define/D content="x"></define>').attrs).toHaveLength(1);
  });

  it("is refused when the define has a body, at the attribute", () => {
    const source = '<define/D content="x">body</define>';
    const error = thrown(source);
    expect(error.message).toBe(
      "`content` is the body of a `<define>` that has one; rename the attribute, or remove the body",
    );
    expect(error.diagnosticCode).toBe("MX_INVALID_DEFINE");
    expect([error.line, error.column]).toEqual([1, source.indexOf("content")]);
  });
});
