/**
 * Pins `patches/htmljs-parser@5.18.0.patch` at the parser level, against
 * both published builds (`index.mjs` and `index.js`), with the same tables
 * the source copy runs (`packages/parser/src/template/mx-after-value.test.ts`
 * and the shared `*.cases.ts` corpora).
 *
 * A space before `:` or `.` inside an attribute value never ends the value:
 * the patched parser reads it as stock 5.18.0 does. FORMER_SPLITS lists the
 * inputs the removed after-value rule split; the PINNED table is what stock
 * 5.18.0 produced, measured before the patch existed.
 *
 * Events are rendered compactly: `<tag>`, `.cls`/`#id` shorthands,
 * `var:"…"`, `@name`, `="value"`, `..."spread"`, `ERR(…)`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as esm from "htmljs-parser";
import { describe, expect, it } from "vitest";
import {
  PORTABLE_PROBES,
  type ProbeParserModule,
  renderProbe,
} from "../packages/parser/src/template/grammar-spec.cases.ts";
import * as source from "../packages/parser/src/template/index.ts";
import {
  ATOMS,
  type AtomParserModule,
  NOT_ATOMS,
  parseScaling,
  RESERVED,
  renderAtoms,
  SUGAR_FORMS,
} from "../packages/parser/src/template/mx-atoms.cases.ts";

import {
  fuzzLineThrows,
  fuzzNamelessThrows,
  fuzzThrows,
  NAMELESS_TAG_ROWS,
  NO_THROW_ROWS,
  type NoThrowParserModule,
  namelessAsciiMismatches,
  renderErrorCodes,
  renderEvents,
  STRAY_CLOSE_ROWS,
} from "../packages/parser/src/template/mx-no-throw.cases.ts";
import {
  AFTER_VALUE_ON_HOLD_ROWS,
  ATOM_AFTER_SYMBOL_ROWS,
  asciiMainMismatches,
  BODY_TEXT_ROWS,
  bodyTextTwinMismatches,
  CONCISE_DASH_ROWS,
  extraWordTwinMismatches,
  NON_WORD_ROWS,
  nonWordTwinMismatches,
  renderAttrRanges,
  renderWhitespaceEvents,
  UNICODE_WHITESPACE_ROWS,
  UNICODE_WORD_ROWS,
  unicodeWhitespaceTwinMismatches,
  unicodeWordTwinMismatches,
} from "../packages/parser/src/template/mx-unicode-words.cases.ts";

type Parser = typeof esm;

const cjs = createRequire(import.meta.url)("htmljs-parser") as Parser;

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

const builds: [string, Parser][] = [
  ["index.mjs", esm],
  ["index.js", cjs],
];

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

// The patch lexes no atom, and neither does the source copy's default row:
// every input of the atom row's corpora (`mx-atoms.cases.ts`) reads as the
// source copy reads it, `:name` left as source text, as stock 5.18.0 reads it.
const sourceDefault = source as unknown as AtomParserModule;
const ATOM_ROW_INPUTS = [
  ...[...ATOMS, ...RESERVED, ...NOT_ATOMS].map(([input]) => input),
  ...SUGAR_FORMS,
];

describe.each(builds)("no atom lexing (%s)", (_name, build) => {
  const mod = build as unknown as AtomParserModule;

  it.each(ATOM_ROW_INPUTS)("reads as the source copy: %j", (input) => {
    const rendered = renderAtoms(mod, input, true);
    expect(rendered).not.toMatch(/atom\(|is reserved/);
    expect(rendered).toBe(renderAtoms(sourceDefault, input, true));
  });

  it("read() returns the source, with no stand-in", () => {
    const code = "<div x=:a y=:bb/>";
    const parser = build.createParser({});
    parser.parse(code);
    expect(parser.read({ start: 0, end: code.length })).toBe(code);
  });

  it("parse time grows linearly with the file (no scan to the end of file)", () => {
    // 32x the input: linear ~32, the end-of-file scan ~1,000 (see
    // parseScaling).
    expect(parseScaling(mod)).toBeLessThan(200);
  }, 60_000);
});

// template-parser-ascii-only-lookbehinds: the same table the source copy
// runs (`packages/parser/src/template/mx-unicode-words.test.ts`).
const namelessMain = JSON.parse(
  readFileSync(
    new URL(
      "../packages/parser/src/template/mx-nameless-ascii.main.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, string>;
const unicodeWordsMain = JSON.parse(
  readFileSync(
    new URL(
      "../packages/parser/src/template/mx-unicode-words.main.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, string>;

describe.each(builds)("non-ASCII identifiers (%s)", (_name, build) => {
  const mod = build as unknown as AtomParserModule;
  const wsMod = build as unknown as AtomParserModule & NoThrowParserModule;

  it.each(UNICODE_WORD_ROWS)("%j", (input, expected) => {
    expect(renderAtoms(mod, input, true)).toBe(expected);
  });

  it("each non-ASCII input renders as its ASCII twin", () => {
    const { total, bad } = unicodeWordTwinMismatches(mod);
    expect(total).toBe(5_994);
    expect(bad).toEqual([]);
  });

  it("ASCII-only input renders as main did", () => {
    const { total, bad } = asciiMainMismatches(mod, unicodeWordsMain);
    expect(total).toBe(983);
    expect(bad).toEqual([]);
  });

  it.each(UNICODE_WHITESPACE_ROWS)(
    "Unicode whitespace in a look-behind: %j",
    (input, expected) => {
      expect(renderWhitespaceEvents(wsMod, input)).toBe(expected);
    },
  );

  it.each(CONCISE_DASH_ROWS)(
    "concise `--` after Unicode whitespace: %j",
    (input, events, ranges) => {
      expect(renderWhitespaceEvents(wsMod, input)).toBe(events);
      expect(renderAttrRanges(mod, input)).toBe(ranges);
    },
  );

  it("Unicode whitespace in a look-behind renders as an ASCII space", () => {
    const { total, bad } = unicodeWhitespaceTwinMismatches(wsMod);
    expect(total).toBe(2_432);
    expect(bad).toEqual([]);
  });

  it.each(AFTER_VALUE_ON_HOLD_ROWS)(
    "the after-value identifier start is ASCII, on hold: %j",
    (input, expected) => {
      expect(renderAtoms(mod, input, true)).toBe(expected);
    },
  );

  it.each(NON_WORD_ROWS)(
    "a symbol is no word character, as in stock: %j",
    (input, expected) => {
      expect(renderAtoms(mod, input, true)).toBe(expected);
    },
  );

  it.each(ATOM_AFTER_SYMBOL_ROWS)(
    "a `:` after a symbol reads as the source copy: %j",
    (input, twin) => {
      for (const code of [input, twin]) {
        expect(renderAtoms(mod, code, true)).toBe(
          renderAtoms(sourceDefault, code, true),
        );
      }
    },
  );

  it("a symbol renders as an ASCII non-word", () => {
    const { total, bad } = nonWordTwinMismatches(mod);
    expect(total).toBe(6_660);
    expect(bad).toEqual([]);
  });

  it("an identifier character renders as an ASCII letter", () => {
    const { total, bad } = extraWordTwinMismatches(mod);
    expect(total).toBe(4_662);
    expect(bad).toEqual([]);
  });

  it.each(BODY_TEXT_ROWS)(
    "body text before `//` is text after Unicode whitespace: %j",
    (input, expected) => {
      expect(renderWhitespaceEvents(wsMod, input)).toBe(expected);
    },
  );

  it("body text after Unicode whitespace renders as after a letter", () => {
    const { total, bad } = bodyTextTwinMismatches(wsMod);
    expect(total).toBe(114);
    expect(bad).toEqual([]);
  });
});

// template-parser-comment-in-text-tag-open-crash: the same table the source
// copy runs (`packages/parser/src/template/mx-no-throw.test.ts`).
describe.each(builds)("the parser never throws (%s)", (_name, build) => {
  const mod = build as unknown as NoThrowParserModule;

  it.each(NO_THROW_ROWS)("%j", (input, expected) => {
    expect(renderEvents(mod, input)).toBe(expected);
  });

  it("no generated input from the delimiter alphabet throws (seed 1)", () => {
    expect(fuzzThrows(mod, 1, 5_000)).toEqual({ total: 5_000, thrown: [] });
  });

  it.each(STRAY_CLOSE_ROWS)(
    "a stray closing tag after a nameless tag: %j",
    (input, events, codes) => {
      expect(renderEvents(mod, input)).toBe(events);
      expect(renderErrorCodes(mod, input)).toBe(codes);
    },
  );

  it("no generated concise-line input throws (seed 1)", () => {
    expect(fuzzLineThrows(mod, 1, 5_000)).toEqual({
      total: 5_000,
      thrown: [],
    });
  });

  it.each(NAMELESS_TAG_ROWS)(
    "a tag that never got its name never throws: %j",
    (input, expected) => {
      expect(renderEvents(mod, input)).toBe(expected);
      expect(renderErrorCodes(mod, input).includes("THROW")).toBe(false);
    },
  );

  it("ASCII nameless and empty-name tags render as main did", () => {
    const { total, bad } = namelessAsciiMismatches(mod, namelessMain);
    expect(total).toBe(2_903);
    expect(bad).toEqual([]);
  });

  it("no generated nameless-tag input throws (seeds 1 and 2)", () => {
    for (const seed of [1, 2]) {
      expect(fuzzNamelessThrows(mod, seed, 20_000)).toEqual({
        total: 20_000,
        thrown: [],
      });
    }
  });
});

// The parser grammar's probe corpus: the same probes the source copy runs,
// against both builds. Probes that use the base-position API are the source
// copy's alone.
describe.each(builds)("parser grammar probes (%s)", (_name, mod) => {
  it.each(PORTABLE_PROBES.map((probe) => [probe.id, probe] as const))(
    "%s",
    (_id, probe) => {
      expect(renderProbe(mod as unknown as ProbeParserModule, probe)).toEqual(
        probe.expected,
      );
    },
  );
});
