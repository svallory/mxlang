import { ATTRIBUTE_VALUE_EXPRESSION } from "@mxlang/core";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { jsxAttrValueExpression } from "./attribute-normalize.ts";
import { compilePreactMx } from "./index.ts";

/**
 * Native elements normalize primitive attribute values; component props stay raw.
 * Hono compiles through the same emitter; this is also its primitive-attribute
 * matrix home. Hono keeps native dynamic-attribute helper routing locally.
 */
describe("preact primitive attribute normalization", () => {
  const compile = (source: string) =>
    compilePreactMx(source, "/virtual/page.mx").code;

  it("leaves component props untouched", () => {
    const code = compile(
      'import Card from "./card.mx"\n<Card title=input.t data-x=input.d class=input.c disabled=input.f/>',
    );
    const call = code.slice(code.indexOf("<Card"));
    expect(call).toContain("title={input.t}");
    expect(call).toContain("data-x={input.d}");
    expect(call).toContain("disabled={input.f}");
    expect(call).not.toMatch(/<Card[^>]*__mxAttr/);
  });

  it("routes native dynamic attributes, class included, through the helper", () => {
    const code = compile("<div data-x=input.d class=input.c/>");
    expect(code).toContain('__mxAttrValue("data-x", input.d, "div")');
    expect(code).toContain('__mxAttrValue("class", input.c, "div")');
    expect(compile("<div ...input.rest/>")).toContain(
      '__mxAttrSpread({ ...input.rest }, "div"',
    );
  });

  it("keeps static attributes byte-identical", () => {
    const code = compile('<div data-x="1" class="a b" disabled/>');
    expect(code).toContain('data-x="1"');
    expect(code).not.toContain("__mxAttrValue");
  });
});

/**
 * The emitted normalizer, evaluated. Stock Marko prints no `class` or `style`
 * for a falsy value, and `NaN` is falsy (`_attr_class(NaN)` is `""`), so the
 * JSX hosts return `undefined` for it as they do for `0` and `""`.
 */
describe("the emitted attribute normalizer", () => {
  // `__mxAttrValue` is the validator the normalizer wraps; a pass-through
  // stands in, since only the normalization is under test.
  const source = jsxAttrValueExpression(false).replace(
    `(${ATTRIBUTE_VALUE_EXPRESSION})`,
    "((n: string, v: unknown, t?: string) => v)",
  );
  const js = ts.transpileModule(`export default ${source}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} as { default?: unknown } };
  new Function("module", "exports", js)(module, module.exports);
  const normalize = module.exports.default as (
    name: string,
    value: unknown,
    tag?: string,
  ) => unknown;

  it.each(["class", "className", "style"])("%s drops NaN", (name) => {
    expect(normalize(name, Number.NaN, "div")).toBeUndefined();
  });

  it.each(["class", "style"])("%s keeps a non-zero number", (name) => {
    expect(normalize(name, 1, "div")).toBe(1);
  });
});
