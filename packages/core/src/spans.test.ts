import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { HostDeclarations } from "./declarations.ts";
import type { Attr, HostTag, Ir, IrNode } from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";

/**
 * Byte-offset contracts for the spans lowering records: attribute name spans,
 * a static attribute's value span, and the whole-tag and tag-name spans on
 * `HostTag`, `Element` and `Component`. Every assertion is made against the
 * source text, so a span that lands on the wrong bytes fails loudly.
 */

const claimAll: HostDeclarations = {
  name: "spans-test",
  attrTags: 2,
  tags: {},
  isElement: () => false,
  isComponent: () => false,
  claimsTag: () => true,
  resolveAttributeMethod: () => true,
};

const elements: HostDeclarations = {
  name: "spans-test",
  attrTags: 2,
  tags: {},
  isElement: () => true,
  isComponent: (name, ctx) => ctx.defines.has(name),
  resolveAttributeMethod: () => true,
};

function irOf(source: string, policy: HostDeclarations): Ir {
  let captured: Ir | undefined;
  compileSource(source, "/tmp/spans.mx", policy, {
    emitIr: (ir) => {
      captured = ir;
      return "";
    },
  });
  if (!captured) throw new Error("no IR captured");
  return captured;
}

function slice(source: string, span: SourceSpan | null | undefined): string {
  if (!span) throw new Error("expected a span");
  return source.slice(span.sourceStart, span.sourceEnd);
}

function hostTag(node: IrNode | undefined): HostTag {
  if (node?.kind !== "HostTag") throw new Error("expected a HostTag");
  return node.tag;
}

function attr(attrs: Attr[], name: string): Attr {
  const hit = attrs.find((a) => "name" in a && a.name === name);
  if (!hit) throw new Error(`no attribute ${name}`);
  return hit;
}

function nameSpanOf(a: Attr): SourceSpan {
  if (!("nameSpan" in a)) throw new Error("attribute carries no nameSpan");
  return a.nameSpan;
}

describe("a default attribute's nameSpan", () => {
  it("covers the tag name, not the `=` and the value's first bytes", () => {
    const source = 'resource="post" table="posts"\n';
    const tag = hostTag(irOf(source, claimAll).body[0]);
    const value = nameSpanOf(attr(tag.attrs, "value"));
    expect(value).toEqual({ sourceStart: 0, sourceEnd: 8 });
    expect(slice(source, value)).toBe("resource");
  });

  it("does the same on an element", () => {
    const source = '<div="a">x</div>\n';
    const el = irOf(source, elements).body[0];
    if (el?.kind !== "Element") throw new Error("expected an Element");
    const value = nameSpanOf(attr(el.attrs, "value"));
    expect(value).toEqual({ sourceStart: 1, sourceEnd: 4 });
    expect(slice(source, value)).toBe("div");
  });

  it("leaves a spelled attribute name alone", () => {
    const source = '<x="post" type="strng">\n</x>\n';
    const tag = hostTag(irOf(source, claimAll).body[0]);
    expect(slice(source, nameSpanOf(attr(tag.attrs, "type")))).toBe("type");
  });

  it("leaves method shorthand on its own name", () => {
    const source = "<x change(ctx) { ctx.a = 1 }>\n</x>\n";
    const tag = hostTag(irOf(source, claimAll).body[0]);
    const span = nameSpanOf(attr(tag.attrs, "change"));
    expect(span).toEqual({ sourceStart: 3, sourceEnd: 9 });
    expect(slice(source, span)).toBe("change");
  });

  it("leaves a modifier attribute spelled `name:modifier`", () => {
    const source = "<x class:a=1>\n</x>\n";
    const tag = hostTag(
      irOf(source, {
        ...claimAll,
        resolveModifier: (a: { name: string; modifier: string }) =>
          `${a.name}-${a.modifier}`,
      } as HostDeclarations).body[0],
    );
    expect(slice(source, nameSpanOf(attr(tag.attrs, "class-a")))).toBe(
      "class:a",
    );
  });
});

describe("a static attribute's valueSpan", () => {
  it("covers the string literal, quotes included, like `Expr.span`", () => {
    const source = '<x="post" type="strng">\n</x>\n';
    const tag = hostTag(irOf(source, claimAll).body[0]);
    const type = attr(tag.attrs, "type");
    if (type.kind !== "static") throw new Error("expected a static attr");
    expect(type.valueSpan).toEqual({ sourceStart: 15, sourceEnd: 22 });
    expect(slice(source, type.valueSpan)).toBe('"strng"');
  });

  it("covers a default attribute's value", () => {
    const source = '<x="post">\n</x>\n';
    const tag = hostTag(irOf(source, claimAll).body[0]);
    const value = attr(tag.attrs, "value");
    if (value.kind !== "static") throw new Error("expected a static attr");
    expect(slice(source, value.valueSpan)).toBe('"post"');
  });

  it("covers a single-quoted value on an element", () => {
    const source = "<div id='a b'>x</div>\n";
    const el = irOf(source, elements).body[0];
    if (el?.kind !== "Element") throw new Error("expected an Element");
    const id = attr(el.attrs, "id");
    if (id.kind !== "static") throw new Error("expected a static attr");
    expect(slice(source, id.valueSpan)).toBe("'a b'");
  });
});

describe("tag spans", () => {
  it("HostTag: name span and whole-tag span, children and close tag included", () => {
    const source = "<x a=1>\n  <y/>\n</x>\n";
    const tag = hostTag(irOf(source, claimAll).body[0]);
    expect(tag.nameSpan).toEqual({ sourceStart: 1, sourceEnd: 2 });
    expect(slice(source, tag.nameSpan)).toBe("x");
    expect(tag.span).toEqual({ sourceStart: 0, sourceEnd: 19 });
    expect(slice(source, tag.span)).toBe("<x a=1>\n  <y/>\n</x>");
    const child = hostTag(tag.children[0]);
    expect(slice(source, child.nameSpan)).toBe("y");
    expect(slice(source, child.span)).toBe("<y/>");
  });

  it("Element: name span and whole-tag span", () => {
    const source = '<section class="a">\n  <br>\n</section>\n';
    const el = irOf(source, elements).body[0];
    if (el?.kind !== "Element") throw new Error("expected an Element");
    expect(slice(source, el.nameSpan)).toBe("section");
    expect(slice(source, el.span)).toBe(
      '<section class="a">\n  <br>\n</section>',
    );
    const br = el.children.find((c) => c.kind === "Element");
    if (br?.kind !== "Element") throw new Error("expected <br>");
    expect(slice(source, br.nameSpan)).toBe("br");
    expect(slice(source, br.span)).toBe("<br>");
  });

  it("Component: reuses nameSpan and adds the whole-tag span", () => {
    const source = "<define/Row|a|>\n  <b>text</b>\n</define>\n<Row(1)/>\n";
    const ir = irOf(source, elements);
    const call = ir.body.find((n) => n.kind === "Component");
    if (call?.kind !== "Component") throw new Error("expected a Component");
    expect(slice(source, call.nameSpan)).toBe("Row");
    expect(slice(source, call.span)).toBe("<Row(1)/>");
  });
});
