// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the inputs are MX source with ${…} placeholders
/**
 * Brief §1.2 A: the catalogue's own examples (ast §3), one row each, with
 * every field and span the example states. The catalogue's offsets were
 * computed by script; a mismatch is a question to the lead, never an edit.
 */
import { describe, expect, it } from "vitest";
import { type ParseOptions, parse } from "./parse.ts";
import { checkInvariants } from "./test-support/invariants.ts";
import { OPTIONS } from "./test-support/options.ts";

// biome-ignore lint/suspicious/noExplicitAny: test rows read nested fields
type Any = any;

function doc(source: string, options: Partial<ParseOptions> = {}): Any {
  const document = parse(source, { ...OPTIONS, ...options });
  expect(
    checkInvariants(document, options.tagShape ?? OPTIONS.tagShape),
  ).toEqual([]);
  return document;
}

const first = (source: string): Any => doc(source).body[0];
const span = (start: number, end: number) => ({ start, end });
const spanless = null;

describe("§3.1 MxDocument", () => {
  it("<p>x</p> is [0, 8) with one tag, no errors, complete", () => {
    const d = doc("<p>x</p>");
    expect(d).toMatchObject({
      type: "MxDocument",
      start: 0,
      end: 8,
      errors: [],
      complete: true,
      source: "<p>x</p>",
      base: { offset: 0, line: 0, column: 0 },
    });
    expect(d.body).toHaveLength(1);
    expect(d.body[0]).toMatchObject({ type: "MxTag", start: 0, end: 8 });
  });

  it("end is base.offset + source.length (not length - 1)", () => {
    const d = doc("<a/>", { base: { offset: 10, line: 1, column: 3 } });
    expect(d).toMatchObject({ start: 10, end: 14 });
    expect(d.body[0]).toMatchObject({ start: 10, end: 14 });
  });
});

describe("§3.2 MxTag", () => {
  const source = '<Row<string>/row(a, b)<T>|item: T| class="x">${item}</Row>';
  it("every head part of the catalogue example", () => {
    const tag = first(source);
    expect(tag).toMatchObject({
      type: "MxTag",
      start: 0,
      end: 58,
      openTag: span(0, 45),
      closeTag: { span: span(52, 58), name: "Row", nameSpan: span(54, 57) },
      name: { kind: "static", value: "Row", span: span(1, 4) },
      typeArgs: {
        type: "MxTypeArguments",
        start: 5,
        end: 11,
        outer: span(4, 12),
        source: "string",
      },
      var: { type: "MxPattern", start: 13, end: 16, source: "row" },
      args: { type: "MxArguments", start: 17, end: 21, source: "a, b" },
      typeParams: { type: "MxTypeParameters", start: 23, end: 24, source: "T" },
      params: {
        type: "MxParameterList",
        start: 26,
        end: 33,
        source: "item: T",
      },
      selfClosed: false,
      concise: false,
      bodyMode: "html",
      incomplete: false,
      shorthands: [],
    });
    expect(tag.attributes[0]).toMatchObject({
      type: "MxAttribute",
      start: 35,
      end: 44,
    });
    expect(tag.body[0]).toMatchObject({
      type: "MxPlaceholder",
      start: 45,
      end: 52,
    });
  });

  it("a self-closed tag has no body and no closeTag", () => {
    expect(first("<a/>")).toMatchObject({
      body: null,
      closeTag: null,
      selfClosed: true,
      end: 4,
    });
  });

  it("a void tag (tagShape) has no body and no closeTag", () => {
    expect(first("<input type=x>")).toMatchObject({
      bodyMode: "void",
      body: null,
      closeTag: null,
      selfClosed: false,
      end: 14,
      openTag: span(0, 14),
    });
  });

  it("a concise block ends at its last descendant", () => {
    const tag = first("div.a\n  -- some text ${y}\n  span#b");
    expect(tag).toMatchObject({
      concise: true,
      start: 0,
      end: 34,
      closeTag: null,
    });
    expect(tag.body.map((c: Any) => c.type)).toEqual([
      "MxText",
      "MxPlaceholder",
      "MxTag",
    ]);
  });

  it("concise text after -- starts after the marker", () => {
    const tag = first("div -- hi ${y}");
    expect(tag.body[0]).toMatchObject({
      type: "MxText",
      start: 7,
      end: 10,
      raw: "hi ",
    });
  });

  it("</> gives a closeTag with null name and nameSpan", () => {
    expect(first("<div></>").closeTag).toEqual({
      span: span(5, 8),
      name: null,
      nameSpan: null,
    });
  });

  it("the close name is the written one, sugar included", () => {
    expect(first("<div:x></div:x>").closeTag).toEqual({
      span: span(7, 15),
      name: "div:x",
      nameSpan: span(9, 14),
    });
  });
});

describe("§3.3 MxTagName", () => {
  it("<input:email> splits at the first ':'", () => {
    const tag = first("<input:email/>");
    expect(tag.name).toEqual({
      kind: "static",
      value: "input",
      span: span(1, 6),
    });
    expect(tag.shorthands).toEqual([
      {
        type: "MxShorthand",
        start: 6,
        end: 12,
        sigil: ":",
        position: "tag",
        value: { kind: "static", value: "email", span: span(7, 12) },
        operator: null,
        default: null,
        args: null,
      },
    ]);
  });

  it("<${x}> is a dynamic name: the one expression of empty quasis", () => {
    const tag = first("<${x}/>");
    expect(tag.name.kind).toBe("dynamic");
    expect(tag.name.span).toEqual(span(1, 5));
    expect(tag.name.expression).toMatchObject({
      type: "MxExpression",
      start: 3,
      end: 4,
      source: "x",
      outer: span(1, 5),
    });
  });

  it("<my-${x}> is one container over the whole written name", () => {
    const tag = first("<my-${x}/>");
    expect(tag.name.expression).toMatchObject({
      start: 1,
      end: 8,
      source: "my-${x}",
    });
  });

  it("<.card> is unnamed, empty span right after <", () => {
    expect(first("<.card/>").name).toEqual({
      kind: "unnamed",
      span: span(1, 1),
    });
  });

  it("<:email> is unnamed with a : sugar", () => {
    const tag = first("<:email/>");
    expect(tag.name).toEqual({ kind: "unnamed", span: span(1, 1) });
    expect(tag.shorthands[0]).toMatchObject({ sigil: ":", start: 1, end: 7 });
  });

  it("concise unnamed: at the first sugar character", () => {
    expect(first("#a").name).toEqual({ kind: "unnamed", span: span(0, 0) });
  });
});

describe("§3.5 MxAttribute", () => {
  const source =
    '<input disabled type="email" value:=draft onInput(e) { set(e) }/>';
  it("the catalogue example", () => {
    const [disabled, type, value, onInput] = first(source).attributes;
    expect(disabled).toEqual({
      type: "MxAttribute",
      start: 7,
      end: 15,
      name: "disabled",
      nameSpan: span(7, 15),
      modifier: null,
      modifierSpan: spanless,
      operator: null,
      value: null,
      args: null,
    });
    expect(type).toMatchObject({
      start: 16,
      end: 28,
      name: "type",
      nameSpan: span(16, 20),
      operator: "=",
      value: { type: "MxExpression", start: 21, end: 28, source: '"email"' },
    });
    expect(value).toMatchObject({
      start: 29,
      end: 41,
      name: "value",
      operator: ":=",
      value: { start: 36, end: 41 },
    });
    expect(onInput).toMatchObject({
      start: 42,
      end: 63,
      nameSpan: span(42, 49),
      operator: null,
      value: { type: "MxMethod", start: 49, end: 63 },
    });
  });

  it("the default value: name null, zero-width nameSpan at '='", () => {
    const attr = first("<if=a></if>").attributes[0];
    expect(attr).toMatchObject({
      name: null,
      nameSpan: span(3, 3),
      start: 3,
      end: 5,
      operator: "=",
      value: { start: 4, end: 5, source: "a" },
    });
  });

  it("an async method starts the attribute at async (min rule)", () => {
    const attr = first("<div async onLoad<T>(e: T) { a() }/>").attributes[0];
    expect(attr).toMatchObject({
      start: 5,
      end: 34,
      nameSpan: span(11, 17),
      value: {
        type: "MxMethod",
        start: 5,
        end: 34,
        async: true,
        typeParams: { start: 18, end: 19, outer: span(17, 20) },
      },
    });
  });

  it("attribute arguments without a body", () => {
    const attr = first("<a f(1)/>").attributes[0];
    expect(attr).toMatchObject({
      name: "f",
      start: 3,
      end: 7,
      args: { type: "MxArguments", start: 5, end: 6, outer: span(4, 7) },
    });
  });

  it("the name is the head before the colon (addendum 12)", () => {
    expect(first("<a class:x=1/>").attributes[0]).toMatchObject({
      name: "class",
      nameSpan: span(3, 8),
      modifier: "x",
      modifierSpan: span(9, 10),
    });
  });

  it("the modifier split (decision 163 addendum 12): the name is the head", () => {
    // `<a a:b=1/>`: one colon.
    expect(first("<a a:b=1/>").attributes[0]).toMatchObject({
      name: "a",
      nameSpan: span(3, 4),
      modifier: "b",
      modifierSpan: span(5, 6),
    });
    // Several colons: the split is at the last (`a:b:c` → modifier `c`).
    expect(first("<a a:b:c=1/>").attributes[0]).toMatchObject({
      name: "a:b",
      nameSpan: span(3, 6),
      modifier: "c",
      modifierSpan: span(7, 8),
    });
    // Doubled colons cannot reach the split: `::` is reserved (decision 156)
    // and the template parser rejects it before the attribute exists. The
    // type-level `x::y` case lives in `mx-ast.test.ts`.
    const doubled = doc("<a a::y=1/>");
    expect(doubled.errors[0]).toMatchObject({
      code: "INVALID_EXPRESSION",
      message:
        "`::y` is reserved (decision 156): `::` will be the Symbol.for sugar; write `:y` for an atom",
    });
    expect(doubled.body[0].attributes).toEqual([]);
    // Zero colons.
    expect(first("<a a=1/>").attributes[0]).toMatchObject({
      name: "a",
      modifier: null,
      modifierSpan: null,
    });
    // A colon first is the name sugar, never an attribute modifier.
    expect(first("<a :b=1/>").attributes[0]).toMatchObject({
      type: "MxShorthand",
      sigil: ":",
      value: { value: "b" },
    });
  });

  it('a name ending in a colon: modifier "" with a zero-width span', () => {
    // `<a x:/>`: the bare attribute `x:` — the name is the head `x` and the
    // empty modifier sits after the colon (decision 163 addendum 12).
    expect(first("<a x:/>").attributes[0]).toMatchObject({
      name: "x",
      nameSpan: span(3, 4),
      modifier: "",
      modifierSpan: span(5, 5),
      end: 5,
    });
  });

  it("the split with a bound value (:=)", () => {
    // `a:b:=1`: the parser reports the name `a:b` and `:=` as the operator
    // (Marko's own split, ast §1.3), so the modifier is `b`.
    expect(first("<a a:b:=1/>").attributes[0]).toMatchObject({
      name: "a",
      nameSpan: span(3, 4),
      operator: ":=",
      modifier: "b",
      modifierSpan: span(5, 6),
    });
    expect(first("<a a:b:c:=1/>").attributes[0]).toMatchObject({
      name: "a:b",
      nameSpan: span(3, 6),
      modifier: "c",
      modifierSpan: span(7, 8),
    });
  });

  it("non-ASCII around the colon", () => {
    // `<a é:ü=1/>`: the spans are UTF-16 offsets.
    expect(first("<a é:ü=1/>").attributes[0]).toMatchObject({
      name: "é",
      nameSpan: span(3, 4),
      modifier: "ü",
      modifierSpan: span(5, 6),
    });
  });

  it("the same split on a component, an attribute tag and a native element", () => {
    expect(first("<Card a:b=1/>").attributes[0]).toMatchObject({
      name: "a",
      modifier: "b",
    });
    const attrTag = first("<c><@head a:b=1/></@head></c>");
    expect(attrTag.body[0].attributes[0]).toMatchObject({
      name: "a",
      modifier: "b",
      modifierSpan: span(12, 13),
    });
    expect(first("<div a:b=1/>").attributes[0]).toMatchObject({
      name: "a",
      modifier: "b",
    });
  });
});

describe("§3.5a MxMethod", () => {
  it("<b onInput(e) { set(e) }/>", () => {
    const method = first("<b onInput(e) { set(e) }/>").attributes[0].value;
    expect(method).toMatchObject({
      type: "MxMethod",
      start: 10,
      end: 24,
      async: false,
      typeParams: null,
      params: {
        type: "MxParameterList",
        start: 11,
        end: 12,
        outer: span(10, 13),
      },
      body: { type: "MxStatements", start: 15, end: 23, outer: span(14, 24) },
      source: "(e) { set(e) }",
    });
  });
});

describe("§3.5b MxSpreadAttribute", () => {
  it("<b ...rest/>", () => {
    expect(first("<b ...rest/>").attributes[0]).toMatchObject({
      type: "MxSpreadAttribute",
      start: 3,
      end: 10,
      value: { type: "MxExpression", start: 6, end: 10, source: "rest" },
    });
  });
});

describe("§3.6 MxShorthand", () => {
  it("tag and attribute positions of the catalogue example", () => {
    const tag = first('<a.c#d:b title="t" .big :mail/>');
    expect(
      tag.shorthands.map((s: Any) => [s.sigil, s.start, s.end, s.value.span]),
    ).toEqual([
      [".", 2, 4, span(3, 4)],
      ["#", 4, 6, span(5, 6)],
      [":", 6, 8, span(7, 8)],
    ]);
    const attrs = tag.attributes.filter((a: Any) => a.type === "MxShorthand");
    expect(
      attrs.map((s: Any) => [
        s.sigil,
        s.position,
        s.start,
        s.end,
        s.value.value,
      ]),
    ).toEqual([
      [".", "attribute", 19, 23, "big"],
      [":", "attribute", 24, 29, "mail"],
    ]);
  });

  it("<a.${x}:b>: a dynamic class and a static :b", () => {
    const [dot, colon] = first("<a.${x}:b/>").shorthands;
    expect(dot).toMatchObject({ sigil: ".", start: 2, end: 7 });
    expect(dot.value.kind).toBe("dynamic");
    expect(dot.value.span).toEqual(span(3, 7));
    expect(dot.value.template).toMatchObject({ start: 5, end: 6, source: "x" });
    expect(dot.value.quasis).toEqual([span(3, 3), span(7, 7)]);
    expect(dot.value.expressions).toHaveLength(1);
    expect(dot.value.expressions[0]).toMatchObject({ start: 5, end: 6 });
    expect(dot.value.expressions[0]).not.toBe(dot.value.template);
    expect(colon).toMatchObject({
      sigil: ":",
      start: 7,
      end: 9,
      value: { kind: "static", value: "b" },
    });
  });

  it("a value left empty by the split makes no shorthand (<a.:b>)", () => {
    const tag = first("<a.:b/>");
    expect(tag.shorthands.map((s: Any) => s.sigil)).toEqual([":"]);
  });

  it("attribute-position chain .c#m.d:y splits into four", () => {
    const shorthands = first("<a .c#m.d:y/>").attributes;
    expect(
      shorthands.map((s: Any) => [s.sigil, s.value.value, s.start, s.end]),
    ).toEqual([
      [".", "c", 3, 5],
      ["#", "m", 5, 7],
      [".", "d", 7, 9],
      [":", "y", 9, 11],
    ]);
  });

  it("#name=expr sets operator and default on the sugar", () => {
    const s = first("<a #q=1/>").attributes[0];
    expect(s).toMatchObject({
      type: "MxShorthand",
      sigil: "#",
      start: 3,
      end: 5,
      operator: "=",
      default: { type: "MxExpression", start: 6, end: 7 },
    });
  });

  it("a sugar's method default has operator null", () => {
    const s = first("<a :n(e) { x }/>").attributes[0];
    expect(s).toMatchObject({
      sigil: ":",
      operator: null,
      default: { type: "MxMethod" },
    });
  });
});

describe("§3.7 MxAttributeTag", () => {
  it("<Card><@head x=1>H</@head></Card>", () => {
    const card = first("<Card><@head x=1>H</@head></Card>");
    expect(card.body[0]).toMatchObject({
      type: "MxAttributeTag",
      start: 6,
      end: 26,
      name: { value: "head", span: span(7, 12) },
      bodyMode: "html",
    });
  });

  it("head sugar is not split: <@svg:rect>", () => {
    const tag = first("<a><@svg:rect/></a>").body[0];
    expect(tag.name.value).toBe("svg:rect");
    expect(tag.shorthands).toEqual([]);
  });
});

describe("§3.8 MxText (the whitespace layer, PR 3)", () => {
  it("node span and raw are the authored run; value is normalized", () => {
    const text = first("<p>  a\n  b</p>").body[0];
    expect(text).toMatchObject({
      type: "MxText",
      start: 3,
      end: 10,
      raw: "  a\n  b",
      value: " a b",
    });
    expect(text.valueSpan).toEqual(span(3, 10));
  });
});

describe("§3.9 MxPlaceholder", () => {
  it("<p>$!{html}</p>", () => {
    expect(first("<p>$!{html}</p>").body[0]).toMatchObject({
      type: "MxPlaceholder",
      start: 3,
      end: 11,
      escape: false,
      expression: { start: 6, end: 10, outer: span(3, 11) },
    });
  });

  it("the container span includes inner whitespace", () => {
    expect(first("<p>${ y }</p>").body[0].expression).toMatchObject({
      start: 5,
      end: 8,
    });
  });
});

describe("§3.10 MxModuleStatement and MxScriptlet", () => {
  it("static with a trailing comment: span includes the comment", () => {
    expect(first("static const A = 1 // trailing")).toMatchObject({
      type: "MxModuleStatement",
      keyword: "static",
      start: 0,
      end: 30,
      untrimmedEnd: 30,
      code: {
        type: "MxStatements",
        start: 7,
        end: 30,
        source: "const A = 1 // trailing",
      },
    });
  });

  it("untrimmedEnd: trailing whitespace", () => {
    expect(first("static const A = 1   \n<div/>")).toMatchObject({
      end: 18,
      untrimmedEnd: 21,
    });
  });

  it("untrimmedEnd: blank lines after (the range stops at the line end)", () => {
    expect(first("export const B = 2\n\n\n<div/>")).toMatchObject({
      end: 18,
      untrimmedEnd: 18,
      code: { start: 0, end: 18 },
    });
  });

  it("untrimmedEnd: CRLF", () => {
    expect(first("static a = 1 // c\r\ndiv")).toMatchObject({
      end: 17,
      untrimmedEnd: 17,
    });
  });

  it("untrimmedEnd: end of file", () => {
    expect(first('import x from "y"')).toMatchObject({
      keyword: "import",
      end: 17,
      untrimmedEnd: 17,
      code: { start: 0, end: 17 },
    });
  });

  it("$ stmt: [0, 14), code [2, 14)", () => {
    expect(first("$ const z = 1;")).toMatchObject({
      type: "MxScriptlet",
      start: 0,
      end: 14,
      block: false,
      code: { type: "MxStatements", start: 2, end: 14 },
    });
  });

  it("$ { block }: code inside the braces, outer with them", () => {
    expect(first("$ { a }")).toMatchObject({
      block: true,
      code: { start: 3, end: 6, outer: span(2, 7) },
    });
  });

  it("a keyword outside the target's set is a tag", () => {
    const d = doc("class Foo", {
      statementKeywords: new Set(["import", "static", "export"]),
    });
    expect(d.body[0]).toMatchObject({
      type: "MxTag",
      name: { value: "class" },
    });
  });

  it("nested concise statement: the template parser's ROOT_TAG_ONLY (decision 163 addendum 7)", () => {
    const d = doc("div\n  static x = 1");
    expect(d.errors).toEqual([
      expect.objectContaining({
        code: "ROOT_TAG_ONLY",
        origin: "template",
        start: 6,
        end: 12,
      }),
    ]);
    expect(d.body[0]).toMatchObject({ type: "MxTag", incomplete: true });
  });

  it("<import x/> records MX_STATEMENT_IN_HTML_MODE (decision 149, PR 2b)", () => {
    // A statement tag nested as an html tag: the front end records it, the
    // tag stays in the tree (ast \u00a73.13).
    const d = doc("<import x/>");
    expect(d.errors).toEqual([
      expect.objectContaining({
        code: "MX_STATEMENT_IN_HTML_MODE",
        origin: "front-end",
        start: 1,
        end: 7,
      }),
    ]);
    expect(d.body[0]).toMatchObject({
      type: "MxTag",
      name: { value: "import" },
    });
  });
});

describe("§3.11 comments and declarations", () => {
  it("the four catalogue examples", () => {
    const d = doc("<!-- a --><![CDATA[ d ]]><!doctype html><?xml v?>");
    expect(d.body).toEqual([
      {
        type: "MxComment",
        start: 0,
        end: 10,
        kind: "html",
        value: " a ",
        valueSpan: span(4, 7),
      },
      {
        type: "MxCDATA",
        start: 10,
        end: 25,
        value: " d ",
        valueSpan: span(19, 22),
      },
      {
        type: "MxDoctype",
        start: 25,
        end: 40,
        value: "doctype html",
        valueSpan: span(27, 39),
      },
      {
        type: "MxDeclaration",
        start: 40,
        end: 49,
        value: "xml v",
        valueSpan: span(42, 47),
      },
    ]);
  });

  it("open-tag comments are MxComment items among the attributes", () => {
    const attrs = first("<div // c\n /* d */ a=1></div>").attributes;
    expect(attrs.map((a: Any) => [a.type, a.kind ?? a.name])).toEqual([
      ["MxComment", "line"],
      ["MxComment", "block"],
      ["MxAttribute", "a"],
    ]);
    expect(attrs[1]).toMatchObject({ value: " d ", valueSpan: span(13, 16) });
  });

  it("concise comments", () => {
    const d = doc("// a\n/* b */");
    expect(d.body.map((c: Any) => c.kind)).toEqual(["line", "block"]);
  });
});

describe("§3.12 body modes", () => {
  it("parsed-text bodies hold text, not tags", () => {
    const script = first("<script> <x> </script>");
    expect(script.bodyMode).toBe("parsed-text-preserve");
    expect(script.body.map((c: Any) => c.type)).toEqual(["MxText"]);
  });
  it("preserve", () => {
    expect(first("<pre> a </pre>").bodyMode).toBe("preserve");
  });
});

describe("§3.13 errors", () => {
  it("<div></span>: MISMATCHED_CLOSING_TAG, div [0, 5) incomplete", () => {
    const d = doc("<div></span>");
    expect(d.complete).toBe(false);
    expect(d.errors).toEqual([
      {
        type: "MxParseError",
        start: 5,
        end: 12,
        code: "MISMATCHED_CLOSING_TAG",
        origin: "template",
        message: expect.any(String),
        context: null,
      },
    ]);
    expect(d.body[0]).toMatchObject({
      start: 0,
      end: 5,
      incomplete: true,
      closeTag: null,
    });
  });

  it("MISSING_END_TAG at EOF keeps the nodes that arrived (decision 163 addendum 8)", () => {
    const d = doc("<div><p>x");
    expect(d.errors[0]).toMatchObject({
      code: "MISSING_END_TAG",
      start: 5,
      end: 8,
    });
    const div = d.body[0];
    expect(div).toMatchObject({ start: 0, end: 9, incomplete: true });
    expect(div.body[0]).toMatchObject({ start: 5, end: 9, incomplete: true });
    expect(div.body[0].body[0]).toMatchObject({
      type: "MxText",
      start: 8,
      end: 9,
    });
  });

  it("MISSING_END_TAG after completed children", () => {
    const d = doc("<div>\n  <p>x</p>\n  hello");
    expect(d.errors[0]).toMatchObject({
      code: "MISSING_END_TAG",
      start: 0,
      end: 5,
    });
    expect(d.body[0]).toMatchObject({ start: 0, end: 24, incomplete: true });
    // The whitespace-only run `\n  ` before <p> is layout and no node (PR 3).
    expect(d.body[0].body[0]).toMatchObject({
      type: "MxTag",
      incomplete: false,
      end: 16,
    });
  });

  it("an error inside an open tag: the attribute read so far, no value", () => {
    const d = doc("<div a=(1");
    expect(d.errors[0]).toMatchObject({
      code: "MALFORMED_OPEN_TAG",
      start: 7,
    });
    expect(d.body[0]).toMatchObject({
      incomplete: true,
      start: 0,
      end: 7,
      body: null,
    });
    expect(d.body[0].attributes[0]).toMatchObject({ name: "a", value: null });
  });

  it("three-deep incomplete chain", () => {
    const d = doc("<a><b><c>x</a>");
    expect(d.complete).toBe(false);
    const a = d.body[0];
    const b = a.body[0];
    const c = b.body[0];
    for (const tag of [a, b, c]) expect(tag.incomplete).toBe(true);
    expect(c.end).toBeLessThanOrEqual(b.end);
    expect(b.end).toBeLessThanOrEqual(a.end);
  });
});

describe("PR 2b front-end rules on interim shapes", () => {
  it("a bare `,` line is an unnamed MxTag beside MX_TAG_NAME_MISSING (decision 163 addendum 9)", () => {
    // The nameless node stays in the tree beside the recorded error.
    const d = doc(",");
    expect(d.errors).toEqual([
      expect.objectContaining({
        code: "MX_TAG_NAME_MISSING",
        origin: "front-end",
        start: 1,
        end: 1,
      }),
    ]);
    expect(d.body[0]).toMatchObject({
      type: "MxTag",
      name: { kind: "unnamed", span: span(1, 1) },
      start: 1,
      end: 1,
    });
  });
});

describe("template parser shapes the catalogue does not name", () => {
  it("a concise attribute group reports a comment before the name: one tag", () => {
    const d = doc("[/*c*/ div x=1]");
    expect(d.body).toHaveLength(1);
    expect(d.body[0]).toMatchObject({
      type: "MxTag",
      name: { kind: "static", value: "div" },
    });
    expect(d.body[0].attributes.map((a: Any) => a.type)).toEqual([
      "MxComment",
      "MxAttribute",
    ]);
  });

  it("an HTML-mode tag with no name (<,/>) is unnamed, right after <, beside MX_TAG_NAME_MISSING", () => {
    // Decision 163 addendum 9: the front end records MX_TAG_NAME_MISSING.
    expect(doc("<,/>").errors).toEqual([
      expect.objectContaining({
        code: "MX_TAG_NAME_MISSING",
        origin: "front-end",
        start: 1,
        end: 1,
      }),
    ]);
    expect(first("<,/>")).toMatchObject({
      start: 0,
      end: 4,
      name: { kind: "unnamed", span: span(1, 1) },
    });
  });

  it("a statement's continuation lines belong to the statement", () => {
    const d = doc("static const a = 1\n,\n|| x=1");
    expect(d.body).toHaveLength(1);
    expect(d.body[0]).toMatchObject({ type: "MxModuleStatement", start: 0 });
  });

  it("a tag closed without a close tag ends at its last descendant", () => {
    // The parser's close range ends one short of a block scriptlet here.
    const tag = first("div\n  $ { a }C");
    expect(tag.body[0]).toMatchObject({ type: "MxScriptlet", end: 13 });
    expect(tag.end).toBe(13);
  });

  it("<,>a reports MISSING_END_TAG since #406 (it threw before)", () => {
    // PR 2b adds MX_TAG_NAME_MISSING beside it; the template error still
    // leads the differential (it is today's parse error).
    const d = doc("<,>a");
    expect(d.complete).toBe(false);
    expect(d.errors).toEqual([
      expect.objectContaining({
        code: "MX_TAG_NAME_MISSING",
        origin: "front-end",
      }),
      expect.objectContaining({ code: "MISSING_END_TAG", origin: "template" }),
    ]);
  });
});

describe("review fixes (decision 163 addenda 10, 11)", () => {
  it("B1: arguments after a sugar are kept on the node, atoms included", () => {
    const s = first("<div .c(:a)/>").attributes[0];
    expect(s).toMatchObject({
      type: "MxShorthand",
      sigil: ".",
      start: 5,
      end: 7,
      args: {
        type: "MxArguments",
        start: 8,
        end: 10,
        outer: span(7, 11),
        atoms: [{ type: "MxAtom", start: 8, end: 10, name: "a" }],
      },
    });
  });

  it("a statement a template error cuts short is kept (addendum 10)", () => {
    const cases: [string, number, number][] = [
      // input, end (right-trimmed), untrimmedEnd
      ["static const x = (", 6, 6],
      ["static", 6, 6],
      ['import x from "y', 13, 14],
      ["export const s = `a", 16, 17],
      ["server const s = 'a", 16, 17],
      ["client const c = (1 +", 6, 6],
      ["class X { m() { return (", 5, 5],
    ];
    for (const [input, end, untrimmedEnd] of cases) {
      const d = doc(input);
      if (input === "static") {
        expect(d.complete, input).toBe(true);
        continue;
      }
      expect(d.complete, input).toBe(false);
      expect(d.body[0], input).toMatchObject({
        type: "MxModuleStatement",
        start: 0,
        end,
        untrimmedEnd,
      });
    }
  });

  it("the default value's name is zero-width at the `(` of a method (ast §3.5)", () => {
    expect(first("<foo <A>(a) {x}/>").attributes[0]).toMatchObject({
      name: null,
      nameSpan: span(8, 8),
      start: 5,
      value: { type: "MxMethod", start: 5 },
    });
    expect(first("<div async <T>(a) {b}/>").attributes[0]).toMatchObject({
      nameSpan: span(14, 14),
      start: 5,
    });
    expect(first("<foo (a) {x}/>").attributes[0].nameSpan).toEqual(span(5, 5));
  });

  it("a concise head ends at its last non-whitespace character", () => {
    expect(first("div a -- b").openTag).toEqual(span(0, 5));
    expect(first("div   \n  p").openTag).toEqual(span(0, 3));
  });
});

describe("§3.14 MxReturn", () => {
  it("<return=x/>", () => {
    const tag = first("<return=x/>");
    expect(tag).toMatchObject({
      type: "MxReturn",
      start: 0,
      end: 11,
      bodyMode: "void",
    });
    expect(tag.attributes[0].value).toMatchObject({ start: 8, end: 9 });
  });
});

describe("§4.3 MxAtom", () => {
  it("<input accept=[:title, :rename-all]/>", () => {
    const value = first("<input accept=[:title, :rename-all]/>").attributes[0]
      .value;
    expect(value.atoms).toEqual([
      { type: "MxAtom", start: 15, end: 21, name: "title" },
      { type: "MxAtom", start: 23, end: 34, name: "rename-all" },
    ]);
  });

  it("an atom is listed in the innermost container only (decision 163 addendum 8)", () => {
    const [dot] = first("<a.a-${ :b }/>").shorthands;
    expect(dot.value.template.atoms).toEqual([]);
    expect(dot.value.expressions[0].atoms).toEqual([
      { type: "MxAtom", start: 8, end: 10, name: "b" },
    ]);
  });

  it("no atoms in a tag var or statement", () => {
    expect(first("<a/x/>").var.atoms).toEqual([]);
  });
});
