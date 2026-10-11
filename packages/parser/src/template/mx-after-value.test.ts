/**
 * Pins, against the source copy, that a space before `:` or `.` inside an
 * attribute value never ends the value: the parser reads it as stock
 * htmljs-parser 5.18.0 does. MX once split there (the after-value rule);
 * FORMER_SPLITS lists the inputs it split. The PINNED table is what stock
 * 5.18.0 produced, measured before the rule existed. `patches/
 * htmljs-parser.test.ts` runs the same tables against the patched npm build.
 *
 * Events are rendered compactly: `<tag>`, `.cls`/`#id` shorthands,
 * `var:"…"`, `@name`, `="value"`, `..."spread"`, `ERR(…)`.
 */

import { describe, expect, it } from "vitest";
import * as template from "./index.ts";

type Parser = typeof template;

// What Marko and `close-tag-opener.ts` return from `onOpenTagName`.
const STATEMENT_TAGS = new Set([
  "static",
  "import",
  "export",
  "server",
  "client",
]);

function render(mod: Parser, code: string, statements = false): string {
  const out: string[] = [];
  const parser = mod.createParser({
    onError: (e) => out.push(`ERR(${e.message.slice(0, 70)})`),
    onOpenTagName: (t) => {
      const name = parser.read(t);
      out.push(`<${name}>`);
      if (statements && STATEMENT_TAGS.has(name)) return mod.TagType.statement;
    },
    onAttrArgs: (t) =>
      out.push(`aargs:${JSON.stringify(parser.read(t.value))}`),
    onTagShorthandId: (t) => out.push(`#${parser.read(t)}`),
    onTagShorthandClass: (t) => out.push(`.${parser.read(t)}`),
    onTagVar: (t) => out.push(`var:${JSON.stringify(parser.read(t.value))}`),
    onAttrName: (t) => out.push(`@${parser.read(t)}`),
    onAttrValue: (t) =>
      out.push(
        `=${JSON.stringify(parser.read(t.value))}${t.bound ? "(bound)" : ""}`,
      ),
    onAttrSpread: (t) => out.push(`...${JSON.stringify(parser.read(t.value))}`),
  });
  parser.parse(code);
  return out.join(" ");
}

const builds: [string, Parser][] = [["src/template", template]];

/**
 * [input, rendered events] — inputs the removed after-value rule split into
 * a new attribute. Each now reads as stock 5.18.0 does.
 */
const FORMER_SPLITS: [string, string][] = [
  // Quoted values (html, html, concise).
  ['<a x="1" :b/>', '<a> @x ="\\"1\\" :b"'],
  ['<a x="1" .b/>', '<a> @x ="\\"1\\" .b"'],
  ['input x="1" .b', '<input> @x ="\\"1\\" .b"'],
  ['input x="1" :b', '<input> @x ="\\"1\\" :b"'],
  // `:` after whitespace, with or without an open `?`.
  ["<a x=1 :b/>", '<a> @x ="1 :b"'],
  ["<a x=a.b :c/>", '<a> @x ="a.b :c"'],
  ["<a x=a[0] :b/>", '<a> @x ="a[0] :b"'],
  ["<a x={ a : 1 } :c/>", '<a> @x ="{ a : 1 } :c"'],
  ["<a x=1 ? y : z :b/>", '<a> @x ="1 ? y : z :b"'],
  ["<a x=a ? b : c :d/>", '<a> @x ="a ? b : c :d"'],
  ["<a x=a ? b ? c : d : e :f/>", '<a> @x ="a ? b ? c : d : e :f"'],
  ["<a x=a ? b : c ? d : e :f/>", '<a> @x ="a ? b : c ? d : e :f"'],
  ["<a x=a ? b : c :d :e/>", '<a> @x ="a ? b : c :d :e"'],
  ["<a x=a ? (b) : c :d/>", '<a> @x ="a ? (b) : c :d"'],
  ["<a x=a ? {b:1} : c :d/>", '<a> @x ="a ? {b:1} : c :d"'],
  ["<a x=1 :b, :c/>", '<a> @x ="1 :b" @:c'],
  ["<a x=1 :b=2/>", '<a> @x ="1 :b=2"'],
  ["<a x=a as T :c/>", '<a> @x ="a as T :c"'],
  ["<a x=`a:b` :c/>", '<a> @x ="`a:b` :c"'],
  ['<a x="a :b" :c/>', '<a> @x ="\\"a :b\\" :c"'],
  ["<a x=/a :b/ :c/>", '<a> @x ="/a :b/ :c"'],
  ["<a ...x :b/>", '<a> ..."x :b"'],
  // `??` and `?.` are not ternaries.
  ["<a x=a ?? b :c/>", '<a> @x ="a ?? b :c"'],
  ["<a x=a?.[0] :c/>", '<a> @x ="a?.[0] :c"'],
  ["<a x=a ?.b :c/>", '<a> @x ="a ?.b :c"'],
  ["<a x=a ?? b ? c : d :e/>", '<a> @x ="a ?? b ? c : d :e"'],
  ["<a x=a ? .5 : 1 :e/>", '<a> @x ="a ? .5 : 1 :e"'],
  // A newline is whitespace.
  ["<a x=a\n :b/>", '<a> @x ="a\\n :b"'],
  ["<a x=a ? b : c\n :d/>", '<a> @x ="a ? b : c\\n :d"'],
  // `.` and an identifier start after whitespace: member access.
  ["<a x=(a.b .c) :d/>", '<a> @x ="(a.b .c) :d"'],
  ["<a x=(a.b .c) .d/>", '<a> @x ="(a.b .c) .d"'],
  ["<a x=1 .b/>", '<a> @x ="1 .b"'],
  ["<a x=a.b .c/>", '<a> @x ="a.b .c"'],
  ["<a x=a .b/>", '<a> @x ="a .b"'],
  ["<a x=fn(a) .b/>", '<a> @x ="fn(a) .b"'],
  ["<a x=a[0] .b/>", '<a> @x ="a[0] .b"'],
  ['<a x="s" .b.c/>', '<a> @x ="\\"s\\" .b.c"'],
  ["<a x=1 .b:c/>", '<a> @x ="1 .b:c"'],
  ["<a x=1 .$b/>", '<a> @x ="1 .$b"'],
  ["<a x=1 ._b/>", '<a> @x ="1 ._b"'],
  ["<a x=1 .b=2/>", '<a> @x ="1 .b=2"'],
  ["<a x=a ? b : c .d/>", '<a> @x ="a ? b : c .d"'],
  ["<a ...x .b/>", '<a> ..."x .b"'],
  ["<a x=foo\n  .bar/>", '<a> @x ="foo\\n  .bar"'],
  // A ternary inside a group / template expression / comment holds no depth.
  ["<a x=(a ? b : c) :d/>", '<a> @x ="(a ? b : c) :d"'],
  ["<a x=[a ? b : c] :d/>", '<a> @x ="[a ? b : c] :d"'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is MX source, not a JS template
  ["<a x=`${a ? b : c}` :d/>", '<a> @x ="`${a ? b : c}` :d"'],
  ["<a x=a /* ? */ :d/>", '<a> @x ="a /* ? */ :d"'],
  ["<a x=a ? b : (c) :d/>", '<a> @x ="a ? b : (c) :d"'],
  // `?.(`, `??=`, `?.` / `??` inside a ternary arm.
  ["<a x=a?.() :d/>", '<a> @x ="a?.() :d"'],
  ["<a x=a ?.() :d/>", '<a> @x ="a ?.() :d"'],
  ["<a x=a ??= b :d/>", '<a> @x ="a ??= b :d"'],
  ["<a x=a ? b?.c : d :e/>", '<a> @x ="a ? b?.c : d :e"'],
  ["<a x=a ? b??c : d :e/>", '<a> @x ="a ? b??c : d :e"'],
  // TS operators.
  ["<a x=a satisfies T :d/>", '<a> @x ="a satisfies T :d"'],
  ["<a x=[1] as const :d/>", '<a> @x ="[1] as const :d"'],
  // CRLF is whitespace too.
  ["<a x=a\r\n :b/>", '<a> @x ="a\\r\\n :b"'],
  ["<a x=a\r\n .b/>", '<a> @x ="a\\r\\n .b"'],
  // A TS return type with a space before `:` stays in the value.
  ["<a x=(a) :T => a/>", '<a> @x ="(a) :T => a"'],
  [
    "<a x=function (a) :T { return a }/>",
    '<a> @x ="function (a) :T { return a }"',
  ],
  // So does one with a newline after the `:`.
  ["<a x=(a) :\n T => a/>", '<a> @x ="(a) :\\n T => a"'],
  // A bare `:` before the end of the tag or the line stays in the value too.
  ["<a x=1 :/>", "<a> @x ERR(EOF reached while parsing regular expression)"],
  [
    "<a x=1 :>y</a>",
    '<a> @x ERR(Mismatched group. A closing ">" character was found but it is not matc)',
  ],
  ['<a x="1" :/>', "<a> @x ERR(EOF reached while parsing regular expression)"],
  ["<a x=a.b :/>", "<a> @x ERR(EOF reached while parsing regular expression)"],
  ["<a x=1 :\n/>", "<a> @x ERR(EOF reached while parsing regular expression)"],
  ["a x=1 :", '<a> @x ="1 :"'],
  ["div x=1 :\n  span", '<div> @x ="1 :\\n  span"'],
  // Concise mode.
  ["input x=a.b .c", '<input> @x ="a.b .c"'],
  ["input x=1 ? y : z :b", '<input> @x ="1 ? y : z :b"'],
  ["input x=a ?? b :c", '<input> @x ="a ?? b :c"'],
  ["input x=1 .b, y=2", '<input> @x ="1 .b" @y ="2"'],
  ["input x=1 .b -- text", '<input> @x ="1 .b"'],
  ["input x={a: 1} .b", '<input> @x ="{a: 1} .b"'],
  ["input x=a ? b : c .d", '<input> @x ="a ? b : c .d"'],
  ["input [x=1 .b y=2 :c]", '<input> @x ="1 .b" @y ="2 :c"'],
  ['input x="1" :b=2', '<input> @x ="\\"1\\" :b=2"'],
  ["div.a x=1 :b", '<div> ..a @x ="1 :b"'],
  ["input/b x=1 :c", '<input> var:"b" @x ="1 :c"'],
];

/** [input, rendered events] — stock 5.18.0 behaviour that never moved. */
const PINNED: [string, string][] = [
  ["<a x=1 ? y : z/>", '<a> @x ="1 ? y : z"'],
  ["<a x=a.b/>", '<a> @x ="a.b"'],
  ["<a x=fn (b)/>", '<a> @x ="fn (b)"'],
  ["<a x=1 -b/>", '<a> @x ="1 -b"'],
  ["<a x=(a.b .c)/>", '<a> @x ="(a.b .c)"'],
  ["<a x=a .5/>", '<a> @x ="a .5"'],
  ["<a x=a . b/>", '<a> @x ="a . b"'],
  ["<a x=a. b/>", '<a> @x ="a. b"'],
  ["<a x=1 .5/>", '<a> @x ="1 .5"'],
  ["<a x=1 .0b/>", '<a> @x ="1 .0b"'],
  ["<a x=1 .-b/>", '<a> @x ="1" @.-b'],
  ["<a x={a: 1}/>", '<a> @x ="{a: 1}"'],
  ["<a x={ a : 1 }/>", '<a> @x ="{ a : 1 }"'],
  ["<a x=(a) : T => a/>", '<a> @x ="(a) : T => a"'],
  ["<a x=(a): T => a/>", '<a> @x ="(a): T => a"'],
  ["<a x=a as T/>", '<a> @x ="a as T"'],
  ["<a x=`a:b` y=1/>", '<a> @x ="`a:b`" @y ="1"'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is MX source, not a JS template
  ["<a x=`a ${b ? c : d} :b` y=1/>", '<a> @x ="`a ${b ? c : d} :b`" @y ="1"'],
  ['<a x="a :b" y=1/>', '<a> @x ="\\"a :b\\"" @y ="1"'],
  ["<a x=/a :b/ y=1/>", '<a> @x ="/a :b/" @y ="1"'],
  ["<a x=a ? b :c/>", '<a> @x ="a ? b :c"'],
  ["<a x=a ?b :c/>", '<a> @x ="a ?b :c"'],
  ["<a x=a ?\n b :\n c/>", '<a> @x ="a ?\\n b :\\n c"'],
  ["<a x=a ? (b) : c/>", '<a> @x ="a ? (b) : c"'],
  ["<a x=a ? {b:1} : c/>", '<a> @x ="a ? {b:1} : c"'],
  ["<a x=a ? b : c ? d : e/>", '<a> @x ="a ? b : c ? d : e"'],
  ["<a x=a ?? b ? c : d/>", '<a> @x ="a ?? b ? c : d"'],
  ["<a x=a ? .5 : 1/>", '<a> @x ="a ? .5 : 1"'],
  ["<a/b :c/>", '<a> var:"b :c"'],
  ["<a/b .c/>", '<a> var:"b .c"'],
  ["<a :b/>", "<a> @:b"],
  ["<a :=x/>", '<a> @ ="x"(bound)'],
  ["<a x=1 :=y/>", '<a> @x ="1 :=y"'],
  ["<a x=1 : b/>", '<a> @x ="1 : b"'],
  ["<a x=1 value:b/>", '<a> @x ="1" @value:b'],
  ["<a x=1 class:x=2/>", '<a> @x ="1" @class:x ="2"'],
  ["<a x=1, :b/>", '<a> @x ="1" @:b'],
  [
    "<a x=a ? b :/>",
    "<a> @x ERR(EOF reached while parsing regular expression)",
  ],
  ["input x=a.b", '<input> @x ="a.b"'],
  ["input x=(a.b .c)", '<input> @x ="(a.b .c)"'],
  ["input x=1 ? y : z", '<input> @x ="1 ? y : z"'],
  ["input x=1 .5", '<input> @x ="1 .5"'],
  ["input x={a: 1}", '<input> @x ="{a: 1}"'],
  ["input x=1, .b", '<input> @x ="1" @.b'],
  ["input x=1 #b .c :d", '<input> @x ="1" @#b @.c @:d'],
  ["input [x=1\n .b\n :c]", '<input> @x ="1" @.b @:c'],
];

describe.each(builds)("htmljs-parser patch (%s)", (_name, mod) => {
  it.each(FORMER_SPLITS)("reads as stock: %j", (input, expected) => {
    expect(render(mod, input)).toBe(expected);
  });

  it.each(PINNED)("unchanged: %j", (input, expected) => {
    expect(render(mod, input)).toBe(expected);
  });
});

describe.each(builds)("statement tags (%s)", (_name, mod) => {
  // Statement tags keep their text when the host returns `TagType.statement`.
  it.each([
    "static const x = a .b",
    "static const x = a ?? b :c",
    "static const x = a ? b : c :d",
    'import x from "a" .b',
    "export const x = a .b",
    "server const x = a .b",
    "client const x = a .b",
  ])("no attributes are parsed: %j", (input) => {
    const name = input.split(" ")[0];
    expect(render(mod, input, true)).toBe(`<${name}>`);
  });

  // Without it the line is an ordinary tag.
  it("a non-statement host sees attributes", () => {
    expect(render(mod, "static const x = a .b")).toBe(
      '<static> @const @x ="a .b"',
    );
  });
});

// Default-attribute values (`<if=…>`, `<const/x=…>`, `<let/x=…>`, `<a/x=…>`)
// keep Marko's meaning: a multi-line chain in an `<if>`, `<const>` or `<let`
// value stays one value.
const DEFAULT_ATTRIBUTE: [string, string][] = [
  ["<if=a .b>x</if>", '<if> @ ="a .b"'],
  ["<if=a :b>x</if>", '<if> @ ="a :b"'],
  ["<if=a ?? b :c>x</if>", '<if> @ ="a ?? b :c"'],
  ["<if=foo\n  .bar()>x</if>", '<if> @ ="foo\\n  .bar()"'],
  [
    "<const/x=items\n  .filter(Boolean)/>",
    '<const> var:"x" @ ="items\\n  .filter(Boolean)"',
  ],
  ["<let/x=a .b/>", '<let> var:"x" @ ="a .b"'],
  ["<a/x=a ?? b :c/>", '<a> var:"x" @ ="a ?? b :c"'],
  ["<a :=x .b/>", '<a> @ ="x .b"(bound)'],
  // A named attribute after the default value reads on as stock too.
  ["<if=a b=1 .c>x</if>", '<if> @ ="a" @b ="1 .c"'],
];

describe.each(builds)("default attribute (%s)", (_name, mod) => {
  it.each(DEFAULT_ATTRIBUTE)("%j", (input, expected) => {
    expect(render(mod, input)).toBe(expected);
  });
});
