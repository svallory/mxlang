/**
 * Pins the `patches/htmljs-parser@5.15.0.patch` rule (decision 146) at the
 * parser level, against both published builds (`index.mjs` and `index.js`).
 *
 * After whitespace inside an attribute value:
 *   (a) a `:` immediately followed by an identifier start, with no open `?`
 *       in that value, starts a new attribute;
 *   (b) a `.` immediately followed by an identifier start starts a new
 *       attribute.
 * Everything else keeps stock htmljs-parser behaviour; the PINNED table is
 * what stock 5.15.0 produced, measured before the patch existed.
 *
 * Events are rendered compactly: `<tag>`, `.cls`/`#id` shorthands,
 * `var:"…"`, `@name`, `="value"`, `..."spread"`, `ERR(…)`.
 */
import { createRequire } from "node:module";
import * as esm from "htmljs-parser";
import { describe, expect, it } from "vitest";

type Parser = typeof esm;

const cjs = createRequire(import.meta.url)("htmljs-parser") as Parser;

function render(mod: Parser, code: string): string {
  const out: string[] = [];
  const parser = mod.createParser({
    onError: (e) => out.push(`ERR(${e.message.slice(0, 70)})`),
    onOpenTagName: (t) => out.push(`<${parser.read(t)}>`),
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

const builds: [string, Parser][] = [
  ["index.mjs", esm],
  ["index.js", cjs],
];

/** [input, rendered events] — the behaviour the patch introduces. */
const CHANGED: [string, string][] = [
  // The three probes from the brief (html, html, concise).
  ['<a x="1" :b/>', '<a> @x ="\\"1\\"" @:b'],
  ['<a x="1" .b/>', '<a> @x ="\\"1\\"" @.b'],
  ['input x="1" .b', '<input> @x ="\\"1\\"" @.b'],
  ['input x="1" :b', '<input> @x ="\\"1\\"" @:b'],
  // (a) `:` after whitespace, no open `?`.
  ["<a x=1 :b/>", '<a> @x ="1" @:b'],
  ["<a x=a.b :c/>", '<a> @x ="a.b" @:c'],
  ["<a x=a[0] :b/>", '<a> @x ="a[0]" @:b'],
  ["<a x={ a : 1 } :c/>", '<a> @x ="{ a : 1 }" @:c'],
  ["<a x=1 ? y : z :b/>", '<a> @x ="1 ? y : z" @:b'],
  ["<a x=a ? b : c :d/>", '<a> @x ="a ? b : c" @:d'],
  ["<a x=a ? b ? c : d : e :f/>", '<a> @x ="a ? b ? c : d : e" @:f'],
  ["<a x=a ? b : c ? d : e :f/>", '<a> @x ="a ? b : c ? d : e" @:f'],
  ["<a x=a ? b : c :d :e/>", '<a> @x ="a ? b : c" @:d @:e'],
  ["<a x=a ? (b) : c :d/>", '<a> @x ="a ? (b) : c" @:d'],
  ["<a x=a ? {b:1} : c :d/>", '<a> @x ="a ? {b:1} : c" @:d'],
  ["<a x=1 :b, :c/>", '<a> @x ="1" @:b @:c'],
  ["<a x=1 :b=2/>", '<a> @x ="1" @:b ="2"'],
  ["<a x=a as T :c/>", '<a> @x ="a as T" @:c'],
  ["<a x=`a:b` :c/>", '<a> @x ="`a:b`" @:c'],
  ['<a x="a :b" :c/>', '<a> @x ="\\"a :b\\"" @:c'],
  ["<a x=/a :b/ :c/>", '<a> @x ="/a :b/" @:c'],
  ["<a ...x :b/>", '<a> ..."x" @:b'],
  // `??` and `?.` are not ternaries.
  ["<a x=a ?? b :c/>", '<a> @x ="a ?? b" @:c'],
  ["<a x=a?.[0] :c/>", '<a> @x ="a?.[0]" @:c'],
  ["<a x=a ?.b :c/>", '<a> @x ="a ?.b" @:c'],
  ["<a x=a ?? b ? c : d :e/>", '<a> @x ="a ?? b ? c : d" @:e'],
  ["<a x=a ? .5 : 1 :e/>", '<a> @x ="a ? .5 : 1" @:e'],
  // A newline is whitespace.
  ["<a x=a\n :b/>", '<a> @x ="a" @:b'],
  ["<a x=a ? b : c\n :d/>", '<a> @x ="a ? b : c" @:d'],
  // (b) `.` + identifier start after whitespace.
  ["<a x=(a.b .c) :d/>", '<a> @x ="(a.b .c)" @:d'],
  ["<a x=(a.b .c) .d/>", '<a> @x ="(a.b .c)" @.d'],
  ["<a x=1 .b/>", '<a> @x ="1" @.b'],
  ["<a x=a.b .c/>", '<a> @x ="a.b" @.c'],
  ["<a x=a .b/>", '<a> @x ="a" @.b'],
  ["<a x=fn(a) .b/>", '<a> @x ="fn(a)" @.b'],
  ["<a x=a[0] .b/>", '<a> @x ="a[0]" @.b'],
  ['<a x="s" .b.c/>', '<a> @x ="\\"s\\"" @.b.c'],
  ["<a x=1 .b:c/>", '<a> @x ="1" @.b:c'],
  ["<a x=1 .$b/>", '<a> @x ="1" @.$b'],
  ["<a x=1 ._b/>", '<a> @x ="1" @._b'],
  ["<a x=1 .b=2/>", '<a> @x ="1" @.b ="2"'],
  ["<a x=a ? b : c .d/>", '<a> @x ="a ? b : c" @.d'],
  ["<a ...x .b/>", '<a> ..."x" @.b'],
  ["<a x=foo\n  .bar/>", '<a> @x ="foo" @.bar'],
  // Concise mode.
  ["input x=a.b .c", '<input> @x ="a.b" @.c'],
  ["input x=1 ? y : z :b", '<input> @x ="1 ? y : z" @:b'],
  ["input x=a ?? b :c", '<input> @x ="a ?? b" @:c'],
  ["input x=1 .b, y=2", '<input> @x ="1" @.b @y ="2"'],
  ["input x=1 .b -- text", '<input> @x ="1" @.b'],
  ["input x={a: 1} .b", '<input> @x ="{a: 1}" @.b'],
  ["input x=a ? b : c .d", '<input> @x ="a ? b : c" @.d'],
  ["input x=1 #b .c :d", '<input> @x ="1" @#b @.c @:d'],
  ["input [x=1 .b y=2 :c]", '<input> @x ="1" @.b @y ="2" @:c'],
  ['input x="1" :b=2', '<input> @x ="\\"1\\"" @:b ="2"'],
  ["div.a x=1 :b", '<div> ..a @x ="1" @:b'],
  ["input/b x=1 :c", '<input> var:"b" @x ="1" @:c'],
];

/** [input, rendered events] — stock 5.15.0 behaviour that must not move. */
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
  ["<a x=1 :/>", "<a> @x ERR(EOF reached while parsing regular expression)"],
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
  it.each(CHANGED)("new attribute: %j", (input, expected) => {
    expect(render(mod, input)).toBe(expected);
  });

  it.each(PINNED)("unchanged: %j", (input, expected) => {
    expect(render(mod, input)).toBe(expected);
  });
});
