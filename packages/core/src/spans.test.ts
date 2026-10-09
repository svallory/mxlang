import { WEB_ELEMENTS } from "@mxlang/web-elements";
import { describe, expect, it } from "vitest";
import { compileSource } from "./compile.ts";
import type { HostDeclarations } from "./declarations.ts";
import type { Attr, DelegatedTag, Ir, IrNode } from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";
import { lookup } from "./test-targets.ts";

/**
 * UTF-16 code-unit offset contracts (the unit of every span in the IR) for the spans lowering records: attribute name spans,
 * a static attribute's value span, and the whole-tag and tag-name spans on
 * `DelegatedTag`, `Element` and `Component`. Every assertion is made against the
 * source text, so a span that lands on the wrong text fails loudly.
 */

const claimAll: HostDeclarations = {
  name: "spans-test",
  attrTags: 2,
  tags: {},
  isElement: () => false,
  isComponent: () => false,
  isDelegatedTag: () => true,
  resolveAttributeMethod: () => true,
};

const elements: HostDeclarations = {
  name: "spans-test",
  attrTags: 2,
  tags: {},
  nativeTags: WEB_ELEMENTS,
  isElement: () => true,
  isComponent: (name, ctx) => ctx.defines.has(name),
  resolveAttributeMethod: () => true,
};

function irOf(source: string, policy: HostDeclarations): Ir {
  let captured: Ir | undefined;
  compileSource(source, "/tmp/spans.mx", policy, {
    targets: lookup,
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

function delegatedTag(node: IrNode | undefined): DelegatedTag {
  if (node?.kind !== "DelegatedTag") throw new Error("expected a DelegatedTag");
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
  it('is zero-width at the `=`, as in Marko, not `="pos`', () => {
    const source = 'resource="post" table="posts"\n';
    const tag = delegatedTag(irOf(source, claimAll).body[0]);
    const value = nameSpanOf(attr(tag.attrs, "value"));
    expect(value).toEqual({ sourceStart: 8, sourceEnd: 8 });
    expect(slice(source, value)).toBe("");
    expect(source[value.sourceStart]).toBe("=");
  });

  it("is zero-width on an element too", () => {
    const source = '<div="a">x</div>\n';
    const el = irOf(source, elements).body[0];
    if (el?.kind !== "Element") throw new Error("expected an Element");
    const value = nameSpanOf(attr(el.attrs, "value"));
    expect(value).toEqual({ sourceStart: 4, sourceEnd: 4 });
    expect(source[value.sourceStart]).toBe("=");
  });

  it("leaves a spelled attribute name alone", () => {
    const source = '<x="post" type="strng">\n</x>\n';
    const tag = delegatedTag(irOf(source, claimAll).body[0]);
    expect(slice(source, nameSpanOf(attr(tag.attrs, "type")))).toBe("type");
  });

  it("leaves method shorthand on its own name", () => {
    const source = "<x change(ctx) { ctx.a = 1 }>\n</x>\n";
    const tag = delegatedTag(irOf(source, claimAll).body[0]);
    const span = nameSpanOf(attr(tag.attrs, "change"));
    expect(span).toEqual({ sourceStart: 3, sourceEnd: 9 });
    expect(slice(source, span)).toBe("change");
  });

  it("keeps a non-native colon prop's complete name and authored span", () => {
    const source = "<x class:a=1>\n</x>\n";
    const tag = delegatedTag(
      irOf(source, {
        ...claimAll,
        resolveModifier: (a: { name: string; modifier: string }) =>
          `${a.name}-${a.modifier}`,
      } as HostDeclarations).body[0],
    );
    expect(slice(source, nameSpanOf(attr(tag.attrs, "class:a")))).toBe(
      "class:a",
    );
  });

  it("maps a host-resolved native modifier to its complete authored name", () => {
    const source = "<div class:a=1/>";
    const el = irOf(source, {
      ...elements,
      resolveModifier: (a: { name: string; modifier: string }) =>
        `${a.name}-${a.modifier}`,
    } as HostDeclarations).body[0];
    if (el?.kind !== "Element") throw new Error("expected an Element");
    const span = nameSpanOf(attr(el.attrs, "class-a"));
    expect(span).toEqual({ sourceStart: 5, sourceEnd: 12 });
    expect(slice(source, span)).toBe("class:a");
  });
});

describe("a tag shorthand attribute's nameSpan", () => {
  // `#id` and `.cls` written right after the tag name have no attribute node
  // of their own in Marko's AST; the span is the sigil plus the token, as for
  // the spaced name-sugar form (` .y`), and `valueSpan` is the token alone.
  function shorthand(source: string, name: string): [string, string] {
    let el = irOf(source, elements).body[0];
    // The innermost element is the one carrying the shorthand.
    while (el?.kind === "Element" && el.children[0]?.kind === "Element") {
      el = el.children[0];
    }
    if (el?.kind !== "Element") throw new Error("expected an Element");
    const a = attr(el.attrs, name);
    const nameSpan = nameSpanOf(a);
    expect(Number.isFinite(nameSpan.sourceStart)).toBe(true);
    expect(Number.isFinite(nameSpan.sourceEnd)).toBe(true);
    if (a.kind !== "static") throw new Error("expected a static attribute");
    return [slice(source, nameSpan), slice(source, a.valueSpan)];
  }

  it.each([
    ["<a#x.y/>", "id", "#x", "x"],
    ["<a#x.y/>", "class", ".y", "y"],
    ["<a#x.y.z k=1/>", "id", "#x", "x"],
    ["<a#x.y.z k=1/>", "class", ".y.z", "y.z"],
    ["<div.card/>", "class", ".card", "card"],
    ["a#x.y", "id", "#x", "x"],
    ["a#x.y", "class", ".y", "y"],
    ["a#x.y k=1", "class", ".y", "y"],
    ["ul\n  li.item#n1", "class", ".item", "item"],
    ["ul\n  li.item#n1", "id", "#n1", "n1"],
  ])("%j: %s is spelled %j, value %j", (source, name, spelled, value) => {
    expect(shorthand(source, name)).toEqual([spelled, value]);
  });

  it("agrees with the spaced form on what the name span covers", () => {
    expect(shorthand("<a .y #x/>", "class")).toEqual([".y", "y"]);
    expect(shorthand("<a .y #x/>", "id")).toEqual(["#x", "x"]);
  });
});

describe("a built shorthand's nameSpan", () => {
  // A shorthand class or id with a `${…}` part (or several tokens merged into
  // one) reaches lowering as a value Marko built, which has no loc. The name
  // span still runs from the first sigil to the end of the last token.
  function shorthandName(source: string, name: string): string {
    const el = irOf(source, elements).body[0];
    if (el?.kind !== "Element") throw new Error("expected an Element");
    const span = nameSpanOf(attr(el.attrs, name));
    expect(Number.isFinite(span.sourceStart)).toBe(true);
    expect(Number.isFinite(span.sourceEnd)).toBe(true);
    return slice(source, span);
  }

  it.each([
    ["<div.a.${x}/>", "class", ".a.${x}"],
    ["<div.${x}.${y}/>", "class", ".${x}.${y}"],
    ["<div.${x}.a/>", "class", ".${x}.a"],
    ["<div.a.${x}.b/>", "class", ".a.${x}.b"],
    ["<div.a${x}/>", "class", ".a${x}"],
    ["<div.${x}a/>", "class", ".${x}a"],
    ["<div#a${x}/>", "id", "#a${x}"],
    ["<div.${x}/>", "class", ".${x}"],
    ["<div#${x}/>", "id", "#${x}"],
    ["<div.a.${x} k=1/>", "class", ".a.${x}"],
    ["div.a.${x}", "class", ".a.${x}"],
    ["<div#i.a.${x}/>", "class", ".a.${x}"],
    ["<div#i.a.${x}/>", "id", "#i"],
  ])("%j: %s is spelled %j", (source, name, spelled) => {
    expect(shorthandName(source, name)).toBe(spelled);
  });
});

describe("a static attribute's valueSpan", () => {
  it("covers the string literal, quotes included, like `Expr.span`", () => {
    const source = '<x="post" type="strng">\n</x>\n';
    const tag = delegatedTag(irOf(source, claimAll).body[0]);
    const type = attr(tag.attrs, "type");
    if (type.kind !== "static") throw new Error("expected a static attr");
    expect(type.valueSpan).toEqual({ sourceStart: 15, sourceEnd: 22 });
    expect(slice(source, type.valueSpan)).toBe('"strng"');
  });

  it("covers a default attribute's value", () => {
    const source = '<x="post">\n</x>\n';
    const tag = delegatedTag(irOf(source, claimAll).body[0]);
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
  it("DelegatedTag: name span and whole-tag span, children and close tag included", () => {
    const source = "<x a=1>\n  <y/>\n</x>\n";
    const tag = delegatedTag(irOf(source, claimAll).body[0]);
    expect(tag.nameSpan).toEqual({ sourceStart: 1, sourceEnd: 2 });
    expect(slice(source, tag.nameSpan)).toBe("x");
    expect(tag.span).toEqual({ sourceStart: 0, sourceEnd: 19 });
    expect(slice(source, tag.span)).toBe("<x a=1>\n  <y/>\n</x>");
    const child = delegatedTag(tag.children[0]);
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

describe("attribute tag spans", () => {
  const source = '<x>\n  <@y="é">body</@y>\n</x>\n';

  it("AttributeTag: whole-tag span, and a default attribute is zero-width at `=`", () => {
    const tag = delegatedTag(irOf(source, claimAll).body[0]);
    const y = tag.attributeTags[0];
    if (!y) throw new Error("expected an attribute tag");
    expect(slice(source, y.span)).toBe('<@y="é">body</@y>');
    expect(slice(source, y.nameSpan)).toBe("y");
    const value = nameSpanOf(attr(y.attrs, "value"));
    expect(value.sourceStart).toBe(value.sourceEnd);
    expect(source[value.sourceStart]).toBe("=");
  });
});

function firstOfKind<K extends IrNode["kind"]>(
  ir: Ir,
  kind: K,
): Extract<IrNode, { kind: K }> {
  const node = ir.body.find((n) => n.kind === kind);
  if (!node) throw new Error(`no ${kind} in the body`);
  return node as Extract<IrNode, { kind: K }>;
}

function elementChildren(source: string): IrNode[] {
  const el = firstOfKind(irOf(source, elements), "Element");
  return el.children;
}

describe("text, interpolation and comment spans", () => {
  it("Text: span slices the authored text, which `value` has normalized", () => {
    const source = "<div>line one\n  line two</div>\n";
    const text = elementChildren(source)[0];
    if (text?.kind !== "Text") throw new Error("expected a Text");
    expect(text.value).toBe("line one line two");
    expect(slice(source, text.span)).toBe("line one\n  line two");
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
  it("Interpolation: span covers the whole `${...}`, delimiters included", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const source = "<div>before ${name} after</div>\n";
    const interp = elementChildren(source).find(
      (n) => n.kind === "Interpolation",
    );
    if (interp?.kind !== "Interpolation") {
      throw new Error("expected an Interpolation");
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    expect(slice(source, interp.span)).toBe("${name}");
    // `expr.span` stays as it is: the expression only, no delimiters.
    expect(slice(source, interp.expr.span)).toBe("name");
  });

  it("Interpolation: the raw form's span includes the `!`", () => {
    const source = "<div>$!{raw}</div>\n";
    const interp = elementChildren(source)[0];
    if (interp?.kind !== "Interpolation") throw new Error("expected one");
    expect(interp.escaped).toBe(false);
    expect(slice(source, interp.span)).toBe("$!{raw}");
  });

  it("Comment: span covers an HTML comment with its delimiters", () => {
    const source = "<div><!-- a comment --></div>\n";
    const comment = elementChildren(source)[0];
    if (comment?.kind !== "Comment") throw new Error("expected a Comment");
    expect(comment.html).toBe(true);
    expect(slice(source, comment.span)).toBe("<!-- a comment -->");
  });

  it("Comment: span covers a `//` line comment", () => {
    const source = "<div>\n  // line comment\n</div>\n";
    const comment = elementChildren(source).find((n) => n.kind === "Comment");
    if (comment?.kind !== "Comment") throw new Error("expected a Comment");
    expect(comment.html).toBe(false);
    expect(slice(source, comment.span)).toBe("// line comment");
  });
});

describe("structural node spans", () => {
  it("IfChain: the chain spans `<if>` through the last branch's closing tag; each branch spans its own tag", () => {
    const source =
      "<if=a>\n  x\n</if>\n<else-if=b>\n  y\n</else-if>\n<else>\n  z\n</else>\n";
    const chain = firstOfKind(irOf(source, elements), "IfChain");
    expect(slice(source, chain.span)).toBe(
      "<if=a>\n  x\n</if>\n<else-if=b>\n  y\n</else-if>\n<else>\n  z\n</else>",
    );
    expect(chain.branches).toHaveLength(3);
    expect(slice(source, chain.branches[0]?.span)).toBe("<if=a>\n  x\n</if>");
    expect(slice(source, chain.branches[1]?.span)).toBe(
      "<else-if=b>\n  y\n</else-if>",
    );
    expect(slice(source, chain.branches[2]?.span)).toBe("<else>\n  z\n</else>");
  });

  it("For: span covers the whole tag, body and closing tag included", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const source = "<for|item| of=list>\n  ${item}\n</for>\n";
    const loop = firstOfKind(irOf(source, elements), "For");
    expect(slice(source, loop.span)).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
      "<for|item| of=list>\n  ${item}\n</for>",
    );
  });

  it("Const: span covers the whole tag", () => {
    const source = "<const/n=1+2/>\n";
    const constant = firstOfKind(irOf(source, elements), "Const");
    expect(slice(source, constant.span)).toBe("<const/n=1+2/>");
  });

  it("Define: span covers the whole tag, body and closing tag included", () => {
    const source = "<define/Row|a|>\n  <b>text</b>\n</define>\n";
    const define = firstOfKind(irOf(source, elements), "Define");
    expect(slice(source, define.span)).toBe(
      "<define/Row|a|>\n  <b>text</b>\n</define>",
    );
  });

  it("Import, Static and Export: span covers the authored statement, line terminator excluded", () => {
    const source =
      'import x from "./y";\nstatic const A = 1;\nexport const B = 2;\n<div/>\n';
    const ir = irOf(source, elements);
    expect(slice(source, ir.imports[0]?.span)).toBe('import x from "./y";');
    const [stat, exp] = ir.hoisted;
    if (stat?.kind !== "Static") throw new Error("expected a Static");
    if (exp?.kind !== "Export") throw new Error("expected an Export");
    expect(slice(source, stat.span)).toBe("static const A = 1;");
    expect(slice(source, exp.span)).toBe("export const B = 2;");
  });
});

describe("spans under UTF-16 and CRLF", () => {
  it("an emoji counts two code units before every span after it", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const source = "<div>😀 ${x} tail</div>\n";
    const children = elementChildren(source);
    const [lead, interp, tail] = children;
    if (lead?.kind !== "Text") throw new Error("expected a Text");
    if (interp?.kind !== "Interpolation") {
      throw new Error("expected an Interpolation");
    }
    if (tail?.kind !== "Text") throw new Error("expected a Text");
    expect(slice(source, lead.span)).toBe("😀 ");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    expect(slice(source, interp.span)).toBe("${x}");
    expect(slice(source, tail.span)).toBe(" tail");
    const el = firstOfKind(irOf(source, elements), "Element");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    expect(slice(source, el.span)).toBe("<div>😀 ${x} tail</div>");
  });

  it("CRLF line endings slice correctly (the \r belongs to its line)", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    const source = "<div>\r\n  x ${y}\r\n</div>\r\n";
    const children = elementChildren(source);
    const text = children.find((n) => n.kind === "Text");
    const interp = children.find((n) => n.kind === "Interpolation");
    if (text?.kind !== "Text") throw new Error("expected a Text");
    if (interp?.kind !== "Interpolation") {
      throw new Error("expected an Interpolation");
    }
    expect(slice(source, text.span)).toBe("x ");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    expect(slice(source, interp.span)).toBe("${y}");
    const el = firstOfKind(irOf(source, elements), "Element");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Marko placeholder syntax in template source
    expect(slice(source, el.span)).toBe("<div>\r\n  x ${y}\r\n</div>");

    const ifSource = "<if=a>\r\n  x\r\n</if>\r\n<else>\r\n  y\r\n</else>\r\n";
    const chain = firstOfKind(irOf(ifSource, elements), "IfChain");
    expect(slice(ifSource, chain.span)).toBe(
      "<if=a>\r\n  x\r\n</if>\r\n<else>\r\n  y\r\n</else>",
    );
    expect(slice(ifSource, chain.branches[0]?.span)).toBe(
      "<if=a>\r\n  x\r\n</if>",
    );

    const statements = irOf('import x from "./y";\r\n<div/>\r\n', elements);
    expect(
      slice('import x from "./y";\r\n<div/>\r\n', statements.imports[0]?.span),
    ).toBe('import x from "./y";');
  });
});

describe("non-ASCII source", () => {
  it("every span is a UTF-16 code-unit offset into the source string", () => {
    const source = '<p title="ção"/><x a="é">ção</x>\n';
    const ir = irOf(source, claimAll);
    const x = delegatedTag(
      ir.body.find((n) => n.kind === "DelegatedTag" && n.tag.name === "x"),
    );
    expect(slice(source, x.nameSpan)).toBe("x");
    expect(slice(source, x.span)).toBe('<x a="é">ção</x>');
    const a = attr(x.attrs, "a");
    expect(slice(source, nameSpanOf(a))).toBe("a");
    if (a.kind !== "static") throw new Error("expected a static attr");
    expect(slice(source, a.valueSpan)).toBe('"é"');
    const p = delegatedTag(ir.body[0]);
    const title = attr(p.attrs, "title");
    if (title.kind !== "static") throw new Error("expected a static attr");
    expect(slice(source, title.valueSpan)).toBe('"ção"');
    expect(slice(source, p.span)).toBe('<p title="ção"/>');
  });
});
