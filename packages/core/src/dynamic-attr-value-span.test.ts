import { WEB_ELEMENTS } from "@mxlang/web-elements";
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { HostDeclarations } from "./declarations.ts";
import type { Attr, Ir } from "./ir.ts";
import { lowerSource, type Spanned } from "./ir-entry/index.ts";
import type { SourceSpan } from "./mapping.ts";
import { lookup } from "./test-targets.ts";

/**
 * A dynamic attribute value lowers `(x)`, `<T>x`, `x!`, `x as T` and
 * `x satisfies T` to the plain `x`. The IR marks the wrapper in `valueSpan`
 * (the written value, wrapper included) and `attr.span` covers the whole
 * written attribute. Every assertion is made against the source text.
 */

const elements: HostDeclarations = {
  name: "dynamic-attr-value-span-test",
  attrTags: 2,
  tags: {},
  nativeTags: WEB_ELEMENTS,
  isElement: () => true,
  isComponent: (name, ctx) => ctx.defines.has(name),
  resolveAttributeMethod: () => true,
};

type Named = Exclude<Attr, { kind: "spread" }>;

function slice(source: string, span: SourceSpan | null | undefined): string {
  if (!span) throw new Error("expected a span");
  return source.slice(span.sourceStart, span.sourceEnd);
}

/** The first tag's attributes through `lowerSource` (no element declarations). */
function attrsOf(source: string, options = {}): Spanned<Attr>[] {
  const result = lowerSource(source, "/t.mx", options);
  expect(result.diagnostics).toEqual([]);
  const node = result.ir?.body[0];
  if (node?.kind !== "DelegatedTag") throw new Error("expected a tag");
  return node.tag.attrs;
}

/** The same, through the host path, where `on*` on an element is an event. */
function elementAttrsOf(source: string): Attr[] {
  let captured: Ir | undefined;
  compileSource(source, "/tmp/dynamic-attr-value-span.mx", elements, {
    targets: lookup,
    emitIr: (ir) => {
      captured = ir;
      return "";
    },
  });
  const node = captured?.body[0];
  if (node?.kind !== "Element") throw new Error("expected an Element");
  return node.attrs;
}

function only<T extends Attr>(attrs: readonly T[], name: string): T {
  const hit = attrs.find((a) => "name" in a && a.name === name);
  if (!hit) throw new Error(`no attribute ${name}`);
  return hit;
}

function valueSpanOf(attr: Attr): SourceSpan | undefined {
  if (attr.kind === "boolean") throw new Error("a boolean has no value");
  return attr.valueSpan;
}

describe("a dynamic attribute's valueSpan: the written value, wrapper included", () => {
  // [source, the whole written attribute, the written value, the bare value]
  const wrapped: [string, string, string, string][] = [
    ["<div title=List />", "title=List", "List", "List"],
    ["<div title=(List) />", "title=(List)", "(List)", "List"],
    ["<div title=List! />", "title=List!", "List!", "List"],
    ["<div title=List as any />", "title=List as any", "List as any", "List"],
    [
      "<div title=List satisfies any />",
      "title=List satisfies any",
      "List satisfies any",
      "List",
    ],
    [
      "<div title=(List as any) />",
      "title=(List as any)",
      "(List as any)",
      "List",
    ],
    [
      "<div title=((List as T)!) />",
      "title=((List as T)!)",
      "((List as T)!)",
      "List",
    ],
    [
      "<div title=(/*c*/ List as T /*d*/) />",
      "title=(/*c*/ List as T /*d*/)",
      "(/*c*/ List as T /*d*/)",
      "List",
    ],
    [
      "<div title=(\n  List as T\n) />",
      "title=(\n  List as T\n)",
      "(\n  List as T\n)",
      "List",
    ],
    ["<div title=a+b as T />", "title=a+b as T", "a+b as T", "a+b"],
    ["<div title=f(x) as T />", "title=f(x) as T", "f(x) as T", "f(x)"],
    // Concise form: `<T>x` is a type assertion here (the HTML form is refused).
    ["div title=List", "title=List", "List", "List"],
    ["div title=List as any", "title=List as any", "List as any", "List"],
    ["div title=List!", "title=List!", "List!", "List"],
    ["div title=<any>List", "title=<any>List", "<any>List", "List"],
    ["div title=(<any>List)", "title=(<any>List)", "(<any>List)", "List"],
    [
      "div title=((List as T)!)",
      "title=((List as T)!)",
      "((List as T)!)",
      "List",
    ],
  ];

  it.each(wrapped)("%j", (source, whole, written, bare) => {
    const attr = only(attrsOf(source), "title");
    expect(attr.kind).toBe("dynamic");
    expect(slice(source, valueSpanOf(attr))).toBe(written);
    expect(slice(source, attr.span)).toBe(whole);
    if (attr.kind !== "dynamic") return;
    expect(attr.value.code.replace(/\s+/g, "")).toBe(bare.replace(/\s+/g, ""));
  });

  it("a cast inside a larger expression is not a wrapper of the value", () => {
    // `<any>a+b` is `(<any>a)+b`: the value is the sum, which starts at the cast.
    const source = "div title=<any>a+b";
    const attr = only(attrsOf(source), "title");
    if (attr.kind !== "dynamic") throw new Error("expected dynamic");
    expect(slice(source, attr.valueSpan)).toBe("<any>a+b");
    expect(attr.valueSpan).toEqual(attr.value.span);
  });

  it("a plain value's valueSpan equals its value.span", () => {
    for (const source of ["<div title=List />", "div title=List"]) {
      const attr = only(attrsOf(source), "title");
      if (attr.kind !== "dynamic") throw new Error("expected dynamic");
      expect(attr.valueSpan).toEqual(attr.value.span);
    }
  });

  it("a wrapper makes valueSpan differ from value.span, the way a consumer detects it", () => {
    for (const source of [
      "<div title=(List) />",
      "<div title=List! />",
      "<div title=List as any />",
      "<div title=List satisfies any />",
      "div title=<any>List",
    ]) {
      const attr = only(attrsOf(source), "title");
      if (attr.kind !== "dynamic") throw new Error("expected dynamic");
      expect(attr.valueSpan).not.toEqual(attr.value.span);
      // The bare value is inside the written one.
      expect(attr.valueSpan.sourceStart).toBeLessThanOrEqual(
        attr.value.span.sourceStart,
      );
      expect(attr.valueSpan.sourceEnd).toBeGreaterThanOrEqual(
        attr.value.span.sourceEnd,
      );
    }
  });

  it("a comment after a plain value is not part of it", () => {
    const source = "<div title=List /* c */ />";
    const attr = only(attrsOf(source), "title");
    expect(slice(source, valueSpanOf(attr))).toBe("List");
    expect(slice(source, attr.span)).toBe("title=List");
  });

  it("a comment inside the value stays inside it", () => {
    const source = "div title=List /* c */ as any";
    const attr = only(attrsOf(source), "title");
    expect(slice(source, valueSpanOf(attr))).toBe("List /* c */ as any");
    expect(slice(source, attr.span)).toBe("title=List /* c */ as any");
  });

  it("a wrapped value does not move its neighbours", () => {
    const source = "<div title=List as any other=(1) last=2 />";
    const attrs = attrsOf(source);
    expect(slice(source, only(attrs, "title").span)).toBe("title=List as any");
    expect(slice(source, valueSpanOf(only(attrs, "other")))).toBe("(1)");
    expect(slice(source, only(attrs, "other").span)).toBe("other=(1)");
    expect(slice(source, valueSpanOf(only(attrs, "last")))).toBe("2");
    expect(slice(source, only(attrs, "last").span)).toBe("last=2");
  });

  it("the HTML form of `<T>x` stays a parse error", () => {
    const result = lowerSource("<t a=<T>x />", "/t.mx");
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "MX_PARSE_EXPRESSION",
    );
  });
});

describe("a default attribute's valueSpan", () => {
  it.each([
    ["<x=y />", "=y", "y"],
    ["<x=(y) />", "=(y)", "(y)"],
    ["<x=y as T />", "=y as T", "y as T"],
    ["<x=(y as T) />", "=(y as T)", "(y as T)"],
    ["<x=((y as T)!) />", "=((y as T)!)", "((y as T)!)"],
  ])("%j", (source, whole, written) => {
    const attr = only(attrsOf(source), "value");
    expect(attr.kind).toBe("dynamic");
    expect(slice(source, valueSpanOf(attr))).toBe(written);
    expect(slice(source, attr.span)).toBe(whole);
  });
});

describe("a bound attribute's valueSpan", () => {
  it.each([
    ["<div value:=List />", "value:=List", "List"],
    ["<div value:=(List) />", "value:=(List)", "(List)"],
    ["<div value:=List as any />", "value:=List as any", "List as any"],
    ["<div value:=(List as any) />", "value:=(List as any)", "(List as any)"],
    ["div value:=List!", "value:=List!", "List!"],
  ])("%j", (source, whole, written) => {
    const attr = only(attrsOf(source), "value");
    expect(attr.kind).toBe("bound");
    expect(slice(source, valueSpanOf(attr))).toBe(written);
    expect(slice(source, attr.span)).toBe(whole);
  });

  it("a refinement stays inside the attribute span", () => {
    const source = "<div v:fn:=(q as T) />";
    const attr = only(attrsOf(source), "v");
    expect(attr.kind).toBe("bound");
    expect(slice(source, valueSpanOf(attr))).toBe("(q as T)");
    expect(slice(source, attr.span)).toBe("v:fn:=(q as T)");
  });
});

describe("an event attribute's valueSpan", () => {
  it.each([
    ["<div onClick=fn />", "onClick=fn", "fn"],
    ["<div onClick=(fn) />", "onClick=(fn)", "(fn)"],
    ["<div onClick=fn as any />", "onClick=fn as any", "fn as any"],
    ["<div onClick=fn! />", "onClick=fn!", "fn!"],
  ])("%j", (source, whole, written) => {
    const attr = only(elementAttrsOf(source), "onClick");
    expect(attr.kind).toBe("event");
    expect(slice(source, valueSpanOf(attr))).toBe(written);
    expect(slice(source, attr.span)).toBe(whole);
  });
});

describe("a spread attribute's valueSpan", () => {
  it.each([
    ["<div ...List />", "...List", "List"],
    ["<div ...(List) />", "...(List)", "(List)"],
    ["<div ...List as any />", "...List as any", "List as any"],
    ["<div ...(List as any) />", "...(List as any)", "(List as any)"],
    ["div ...List!", "...List!", "List!"],
  ])("%j", (source, whole, written) => {
    const attr = attrsOf(source)[0];
    if (attr?.kind !== "spread") throw new Error("expected a spread");
    expect(slice(source, attr.valueSpan)).toBe(written);
    expect(slice(source, attr.span)).toBe(whole);
  });
});

describe("a method attribute's valueSpan", () => {
  it("is the method's own range, which is its value.span", () => {
    const source = "<div onLoad(e) { go(e) } />";
    const attr = only(elementAttrsOf(source), "onLoad");
    if (attr.kind !== "event" && attr.kind !== "dynamic") {
      throw new Error(`unexpected kind ${attr.kind}`);
    }
    expect(attr.valueSpan).toBeDefined();
    expect(slice(source, attr.valueSpan)).toBe(slice(source, attr.value.span));
  });
});

describe("with stripTypes: false", () => {
  it("the wrapper stays in the node and valueSpan still covers it", () => {
    const source = "<div title=(List as any) />";
    const attr = only(attrsOf(source, { stripTypes: false }), "title");
    if (attr.kind !== "dynamic") throw new Error("expected dynamic");
    expect(attr.value.node?.type).toBe("TSAsExpression");
    expect(slice(source, attr.valueSpan)).toBe("(List as any)");
    expect(slice(source, attr.span)).toBe("title=(List as any)");
  });
});

describe("under SpannedIr", () => {
  it("every dynamic, bound and spread attribute has a valueSpan", () => {
    const source = "<div a=1 b=(x as T) c:=y ...z />";
    for (const attr of attrsOf(source)) {
      if (attr.kind === "boolean" || attr.kind === "static") continue;
      // Typed as required, no optional chaining.
      const span: SourceSpan = attr.valueSpan;
      expect(span.sourceEnd).toBeGreaterThan(span.sourceStart);
    }
  });
});

describe("diagnostics that read attr.span", () => {
  it("a dropped duplicate attribute ends after its whole written value", () => {
    const source = "<div title=(a as T) title=b />";
    const result = lowerSource(source, "/t.mx");
    const warning = result.diagnostics.find((d) =>
      d.message.startsWith("duplicate attribute"),
    );
    expect(warning).toBeDefined();
    expect(warning?.end?.column).toBe(source.indexOf(") ") + 1);
  });

  it("a contract error on a wrapped value ends after the whole written attribute", () => {
    const source = "<x a=('s' as string)/>\n";
    const result = lowerSource(source, "/t.mx", {
      customTags: { x: { attributes: { a: { type: "number" } } } },
    });
    const error = result.diagnostics.find(
      (d) => d.code === "MX_INVALID_ATTRIBUTE_VALUE",
    );
    expect(error?.end?.offset).toBe(source.indexOf("/>"));
  });
});

describe("a static attribute whose literal carries a wrapper", () => {
  it("keeps valueSpan on the literal and ends attr.span after the wrapper", () => {
    const source = '<div title=("s" as const) />';
    const attr = only(attrsOf(source), "title");
    expect(attr.kind).toBe("static");
    if (attr.kind !== "static") return;
    expect(slice(source, attr.valueSpan)).toBe('"s"');
    expect(slice(source, attr.span)).toBe('title=("s" as const)');
  });

  it("a plain literal is unchanged", () => {
    const source = '<div title="s" />';
    const attr = only(attrsOf(source), "title");
    expect(slice(source, attr.span)).toBe('title="s"');
  });
});
