// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the cases are MX source, whose `${…}` is a placeholder, not a JS template
/**
 * template-parser-ascii-only-lookbehinds (decision 156 addendum 9): the
 * look-behinds and look-aheads htmljs-parser 5.18.0 wrote with an ASCII-only
 * word class, outside the atom path. A non-ASCII identifier character is a
 * word character there too (any code unit at or above U+0080 that is not
 * Unicode whitespace or a line terminator), so each non-ASCII input renders
 * exactly as the same input with an ASCII letter in its place. Run against
 * this source copy (`mx-unicode-words.test.ts`) and both patched npm builds
 * (`patches/htmljs-parser.test.ts`). Events render as in `mx-atoms.cases.ts`.
 */
import {
  type AtomParserModule,
  NON_ASCII_NAMES,
  renderAtoms,
  swapTwins,
  UNICODE_WHITESPACE,
} from "./mx-atoms.cases.ts";
import { type NoThrowParserModule, renderEvents } from "./mx-no-throw.cases.ts";

/**
 * [prefix, suffix] around an expression `V`: every expression position, HTML
 * and concise, each followed by more source the expression must not swallow.
 */
const POSITIONS: [string, string][] = [
  ["<div x=", " y=1/>"],
  ["div x=", " y=1\n"],
  ["<div x=", "\n  y=1/>"],
  ["<div ...", " y=1/>"],
  ["<if=", ">y</if>"],
  ["if=", "\n  -- y\n"],
  ["<t x(", ") y=1/>"],
  ["t x(", ") y=1\n"],
  ["<div x() { return ", " } y=1/>"],
  ["<if(", ")>y</if>"],
  ["<div>${", "}</div>"],
  ["-- ${", "}\n"],
  ["<${", "} y=1/>"],
  ["<div x=`${", "}` y=1/>"],
  ["$ const v = ", ";\n<div/>"],
  ["static const v = ", ";\n<div/>"],
];

/** Expression forms; `K` is the identifier. */
const FORMS = [
  // `canFollowDivision`: a `/` after an identifier is division.
  "K / 2",
  "K / 2 / 3",
  "K\n  / 2",
  "a /K/ 2",
  // `lookBehindForKeyword`: a name ending in a unary keyword is no keyword.
  "Knew",
  "Ktypeof",
  "Kvoid",
  "Kawait",
  "Kdelete",
  "Kasync",
  "Kfunction",
  "a.Knew",
  // `lookBehindForOperator`, `!`: a `!` after an identifier is postfix.
  "K!",
  "K!!",
  "aK!",
  "(c ? K! : b)",
  // `lookBehindForOperator` and `lookAheadForOperator`, `.`: a `.` before an
  // identifier is member access across whitespace.
  "a. K",
  "a.\n  K",
  "a . K",
  "a .K",
];

/** Inputs outside expression positions; `K` is the identifier. */
const TEMPLATES = [
  // `isAsyncMethodPrefix`: a method name after `async`.
  "<div async K() { return 1 }/>",
  "<div async K(v) { return v } y=1/>",
  "div async K() { return 1 }\n",
  // `startsTypeName`: a type alias name after `type`.
  "$ type K = Array<A>\n<div/>",
  "$ type K<T> = Array<T>\n<div/>",
  "static type K = Array<A>\n<div/>",
  "export type K = Array<A>\n<div/>",
  "<div>\n  $ type K = Array<A>\n</div>",
  "div\n  $ type K = Array<A>\n  span\n",
  // `detectAmbiguousCloseAngleBracket`: a non-ASCII operand ends or joins a
  // split expression.
  "<div x=a >K>c</div>",
  "<div x=a + b >c + K>d</div>",
  "<div x=a >b / K>c</div>",
  "<div x=a >K + b>c</div>",
];

/**
 * [input, rendered events] (statement tags as statements). Each expected
 * value is the same input with an ASCII letter in place of each non-ASCII
 * character: the forms above in an HTML and a concise attribute value, a
 * default attribute, a placeholder and a scriptlet, then the templates with
 * a BMP letter, a surrogate pair and a name ending in an operator word.
 */
export const UNICODE_WORD_ROWS: [string, string][] = [
  ["<div x=é / 2 y=1/>", '<div> @x ="é / 2" @y ="1"'],
  ["<div x=é / 2 / 3 y=1/>", '<div> @x ="é / 2 / 3" @y ="1"'],
  ["<div x=é\n  / 2 y=1/>", '<div> @x ="é\\n  / 2" @y ="1"'],
  ["<div x=a /é/ 2 y=1/>", '<div> @x ="a /é/ 2" @y ="1"'],
  ["<div x=énew y=1/>", '<div> @x ="énew" @y ="1"'],
  ["<div x=étypeof y=1/>", '<div> @x ="étypeof" @y ="1"'],
  ["<div x=évoid y=1/>", '<div> @x ="évoid" @y ="1"'],
  ["<div x=éawait y=1/>", '<div> @x ="éawait" @y ="1"'],
  ["<div x=édelete y=1/>", '<div> @x ="édelete" @y ="1"'],
  ["<div x=éasync y=1/>", '<div> @x ="éasync" @y ="1"'],
  ["<div x=éfunction y=1/>", '<div> @x ="éfunction" @y ="1"'],
  ["<div x=a.énew y=1/>", '<div> @x ="a.énew" @y ="1"'],
  ["<div x=é! y=1/>", '<div> @x ="é!" @y ="1"'],
  ["<div x=é!! y=1/>", '<div> @x ="é!!" @y ="1"'],
  ["<div x=aé! y=1/>", '<div> @x ="aé!" @y ="1"'],
  ["<div x=(c ? é! : b) y=1/>", '<div> @x ="(c ? é! : b)" @y ="1"'],
  ["<div x=a. é y=1/>", '<div> @x ="a. é" @y ="1"'],
  ["<div x=a.\n  é y=1/>", '<div> @x ="a.\\n  é" @y ="1"'],
  ["<div x=a . é y=1/>", '<div> @x ="a . é" @y ="1"'],
  ["<div x=a .é y=1/>", '<div> @x ="a" @.é @y ="1"'],
  ["div x=é / 2 y=1\n", '<div> @x ="é / 2" @y ="1"'],
  ["div x=é / 2 / 3 y=1\n", '<div> @x ="é / 2 / 3" @y ="1"'],
  [
    "div x=é\n  / 2 y=1\n",
    '<div> @x ="é" ERR(10-10 A line in concise mode cannot start with "/" unless it starts a "//" or "/*" comment)',
  ],
  ["div x=a /é/ 2 y=1\n", '<div> @x ="a /é/ 2" @y ="1"'],
  ["div x=énew y=1\n", '<div> @x ="énew" @y ="1"'],
  ["div x=étypeof y=1\n", '<div> @x ="étypeof" @y ="1"'],
  ["div x=évoid y=1\n", '<div> @x ="évoid" @y ="1"'],
  ["div x=éawait y=1\n", '<div> @x ="éawait" @y ="1"'],
  ["div x=édelete y=1\n", '<div> @x ="édelete" @y ="1"'],
  ["div x=éasync y=1\n", '<div> @x ="éasync" @y ="1"'],
  ["div x=éfunction y=1\n", '<div> @x ="éfunction" @y ="1"'],
  ["div x=a.énew y=1\n", '<div> @x ="a.énew" @y ="1"'],
  ["div x=é! y=1\n", '<div> @x ="é!" @y ="1"'],
  ["div x=é!! y=1\n", '<div> @x ="é!!" @y ="1"'],
  ["div x=aé! y=1\n", '<div> @x ="aé!" @y ="1"'],
  ["div x=(c ? é! : b) y=1\n", '<div> @x ="(c ? é! : b)" @y ="1"'],
  ["div x=a. é y=1\n", '<div> @x ="a. é" @y ="1"'],
  ["div x=a.\n  é y=1\n", '<div> @x ="a.\\n  é" @y ="1"'],
  ["div x=a . é y=1\n", '<div> @x ="a . é" @y ="1"'],
  ["div x=a .é y=1\n", '<div> @x ="a" @.é @y ="1"'],
  ["<if=é / 2>y</if>", '<if> @ ="é / 2"'],
  ["<if=é / 2 / 3>y</if>", '<if> @ ="é / 2 / 3"'],
  ["<if=é\n  / 2>y</if>", '<if> @ ="é\\n  / 2"'],
  ["<if=a /é/ 2>y</if>", '<if> @ ="a /é/ 2"'],
  ["<if=énew>y</if>", '<if> @ ="énew"'],
  ["<if=étypeof>y</if>", '<if> @ ="étypeof"'],
  ["<if=évoid>y</if>", '<if> @ ="évoid"'],
  ["<if=éawait>y</if>", '<if> @ ="éawait"'],
  ["<if=édelete>y</if>", '<if> @ ="édelete"'],
  ["<if=éasync>y</if>", '<if> @ ="éasync"'],
  ["<if=éfunction>y</if>", '<if> @ ="éfunction"'],
  ["<if=a.énew>y</if>", '<if> @ ="a.énew"'],
  ["<if=é!>y</if>", '<if> @ ="é!"'],
  ["<if=é!!>y</if>", '<if> @ ="é!!"'],
  ["<if=aé!>y</if>", '<if> @ ="aé!"'],
  ["<if=(c ? é! : b)>y</if>", '<if> @ ="(c ? é! : b)"'],
  ["<if=a. é>y</if>", '<if> @ ="a. é"'],
  ["<if=a.\n  é>y</if>", '<if> @ ="a.\\n  é"'],
  ["<if=a . é>y</if>", '<if> @ ="a . é"'],
  ["<if=a .é>y</if>", '<if> @ ="a .é"'],
  ["<div>${é / 2}</div>", '<div> ${"é / 2"}'],
  ["<div>${é / 2 / 3}</div>", '<div> ${"é / 2 / 3"}'],
  ["<div>${é\n  / 2}</div>", '<div> ${"é\\n  / 2"}'],
  ["<div>${a /é/ 2}</div>", '<div> ${"a /é/ 2"}'],
  ["<div>${énew}</div>", '<div> ${"énew"}'],
  ["<div>${étypeof}</div>", '<div> ${"étypeof"}'],
  ["<div>${évoid}</div>", '<div> ${"évoid"}'],
  ["<div>${éawait}</div>", '<div> ${"éawait"}'],
  ["<div>${édelete}</div>", '<div> ${"édelete"}'],
  ["<div>${éasync}</div>", '<div> ${"éasync"}'],
  ["<div>${éfunction}</div>", '<div> ${"éfunction"}'],
  ["<div>${a.énew}</div>", '<div> ${"a.énew"}'],
  ["<div>${é!}</div>", '<div> ${"é!"}'],
  ["<div>${é!!}</div>", '<div> ${"é!!"}'],
  ["<div>${aé!}</div>", '<div> ${"aé!"}'],
  ["<div>${(c ? é! : b)}</div>", '<div> ${"(c ? é! : b)"}'],
  ["<div>${a. é}</div>", '<div> ${"a. é"}'],
  ["<div>${a.\n  é}</div>", '<div> ${"a.\\n  é"}'],
  ["<div>${a . é}</div>", '<div> ${"a . é"}'],
  ["<div>${a .é}</div>", '<div> ${"a .é"}'],
  ["$ const v = é / 2;\n<div/>", '$"const v = é / 2;" <div>'],
  ["$ const v = é / 2 / 3;\n<div/>", '$"const v = é / 2 / 3;" <div>'],
  [
    "$ const v = é\n  / 2;\n<div/>",
    '$"const v = é" ERR(16-16 A line in concise mode cannot start with "/" unless it starts a "//" or "/*" comment)',
  ],
  ["$ const v = a /é/ 2;\n<div/>", '$"const v = a /é/ 2;" <div>'],
  ["$ const v = énew;\n<div/>", '$"const v = énew;" <div>'],
  ["$ const v = étypeof;\n<div/>", '$"const v = étypeof;" <div>'],
  ["$ const v = évoid;\n<div/>", '$"const v = évoid;" <div>'],
  ["$ const v = éawait;\n<div/>", '$"const v = éawait;" <div>'],
  ["$ const v = édelete;\n<div/>", '$"const v = édelete;" <div>'],
  ["$ const v = éasync;\n<div/>", '$"const v = éasync;" <div>'],
  ["$ const v = éfunction;\n<div/>", '$"const v = éfunction;" <div>'],
  ["$ const v = a.énew;\n<div/>", '$"const v = a.énew;" <div>'],
  ["$ const v = é!;\n<div/>", '$"const v = é!;" <div>'],
  ["$ const v = é!!;\n<div/>", '$"const v = é!!;" <div>'],
  ["$ const v = aé!;\n<div/>", '$"const v = aé!;" <div>'],
  ["$ const v = (c ? é! : b);\n<div/>", '$"const v = (c ? é! : b);" <div>'],
  ["$ const v = a. é;\n<div/>", '$"const v = a. é;" <div>'],
  ["$ const v = a.\n  é;\n<div/>", '$"const v = a.\\n  é;" <div>'],
  ["$ const v = a . é;\n<div/>", '$"const v = a . é;" <div>'],
  ["$ const v = a .é;\n<div/>", '$"const v = a .é;" <div>'],
  ["<div async é() { return 1 }/>", '<div> @é method:" return 1 "'],
  [
    "<div async é(v) { return v } y=1/>",
    '<div> @é method:" return v " @y ="1"',
  ],
  ["div async é() { return 1 }\n", '<div> @é method:" return 1 "'],
  ["$ type é = Array<A>\n<div/>", '$"type é = Array<A>" <div>'],
  ["$ type é<T> = Array<T>\n<div/>", '$"type é<T> = Array<T>" <div>'],
  ["static type é = Array<A>\n<div/>", "<static> <div>"],
  ["export type é = Array<A>\n<div/>", "<export> <div>"],
  ["<div>\n  $ type é = Array<A>\n</div>", '<div> $"type é = Array<A>"'],
  ["div\n  $ type é = Array<A>\n  span\n", '<div> $"type é = Array<A>" <span>'],
  [
    "<div x=a >é>c</div>",
    '<div> @x ERR(7-11 Ambiguous ">" in attribute. A ">" preceded by whitespace ends the tag. If "a >é" was intended as a single expression, wrap it in parentheses, eg "=(a >é)". If the tag was instead meant to end at the first ">", leaving "é>" as body content, remove the whitespace before that ">".)',
  ],
  [
    "<div x=a + b >c + é>d</div>",
    '<div> @x ERR(7-19 Ambiguous ">" in attribute. A ">" preceded by whitespace ends the tag. If "a + b >c + é" was intended as a single expression, wrap it in parentheses, eg "=(a + b >c + é)". If the tag was instead meant to end at the first ">", leaving "c + é>" as body content, remove the whitespace before that ">".)',
  ],
  [
    "<div x=a >b / é>c</div>",
    '<div> @x ERR(7-15 Ambiguous ">" in attribute. A ">" preceded by whitespace ends the tag. If "a >b / é" was intended as a single expression, wrap it in parentheses, eg "=(a >b / é)". If the tag was instead meant to end at the first ">", leaving "b / é>" as body content, remove the whitespace before that ">".)',
  ],
  [
    "<div x=a >é + b>c</div>",
    '<div> @x ERR(7-15 Ambiguous ">" in attribute. A ">" preceded by whitespace ends the tag. If "a >é + b" was intended as a single expression, wrap it in parentheses, eg "=(a >é + b)". If the tag was instead meant to end at the first ">", leaving "é + b>" as body content, remove the whitespace before that ">".)',
  ],
  ["<div async 𝑥() { return 1 }/>", '<div> @𝑥 method:" return 1 "'],
  [
    "<div async 𝑥(v) { return v } y=1/>",
    '<div> @𝑥 method:" return v " @y ="1"',
  ],
  ["div async 𝑥() { return 1 }\n", '<div> @𝑥 method:" return 1 "'],
  ["$ type 𝑥 = Array<A>\n<div/>", '$"type 𝑥 = Array<A>" <div>'],
  ["$ type 𝑥<T> = Array<T>\n<div/>", '$"type 𝑥<T> = Array<T>" <div>'],
  ["static type 𝑥 = Array<A>\n<div/>", "<static> <div>"],
  ["export type 𝑥 = Array<A>\n<div/>", "<export> <div>"],
  ["<div>\n  $ type 𝑥 = Array<A>\n</div>", '<div> $"type 𝑥 = Array<A>"'],
  ["div\n  $ type 𝑥 = Array<A>\n  span\n", '<div> $"type 𝑥 = Array<A>" <span>'],
  [
    "<div x=a >𝑥>c</div>",
    '<div> @x ERR(7-12 Ambiguous ">" in attribute. A ">" preceded by whitespace ends the tag. If "a >𝑥" was intended as a single expression, wrap it in parentheses, eg "=(a >𝑥)". If the tag was instead meant to end at the first ">", leaving "𝑥>" as body content, remove the whitespace before that ">".)',
  ],
  [
    "<div x=a + b >c + 𝑥>d</div>",
    '<div> @x ERR(7-20 Ambiguous ">" in attribute. A ">" preceded by whitespace ends the tag. If "a + b >c + 𝑥" was intended as a single expression, wrap it in parentheses, eg "=(a + b >c + 𝑥)". If the tag was instead meant to end at the first ">", leaving "c + 𝑥>" as body content, remove the whitespace before that ">".)',
  ],
  [
    "<div x=a >b / 𝑥>c</div>",
    '<div> @x ERR(7-16 Ambiguous ">" in attribute. A ">" preceded by whitespace ends the tag. If "a >b / 𝑥" was intended as a single expression, wrap it in parentheses, eg "=(a >b / 𝑥)". If the tag was instead meant to end at the first ">", leaving "b / 𝑥>" as body content, remove the whitespace before that ">".)',
  ],
  [
    "<div x=a >𝑥 + b>c</div>",
    '<div> @x ERR(7-16 Ambiguous ">" in attribute. A ">" preceded by whitespace ends the tag. If "a >𝑥 + b" was intended as a single expression, wrap it in parentheses, eg "=(a >𝑥 + b)". If the tag was instead meant to end at the first ">", leaving "𝑥 + b>" as body content, remove the whitespace before that ">".)',
  ],
  ["<div async éin() { return 1 }/>", '<div> @éin method:" return 1 "'],
  [
    "<div async éin(v) { return v } y=1/>",
    '<div> @éin method:" return v " @y ="1"',
  ],
  ["div async éin() { return 1 }\n", '<div> @éin method:" return 1 "'],
  ["$ type éin = Array<A>\n<div/>", '$"type éin = Array<A>" <div>'],
  ["$ type éin<T> = Array<T>\n<div/>", '$"type éin<T> = Array<T>" <div>'],
  ["static type éin = Array<A>\n<div/>", "<static> <div>"],
  ["export type éin = Array<A>\n<div/>", "<export> <div>"],
  ["<div>\n  $ type éin = Array<A>\n</div>", '<div> $"type éin = Array<A>"'],
  [
    "div\n  $ type éin = Array<A>\n  span\n",
    '<div> $"type éin = Array<A>" <span>',
  ],
  [
    "<div x=a >éin>c</div>",
    '<div> @x ERR(7-13 Ambiguous ">" in attribute. A ">" preceded by whitespace ends the tag. If "a >éin" was intended as a single expression, wrap it in parentheses, eg "=(a >éin)". If the tag was instead meant to end at the first ">", leaving "éin>" as body content, remove the whitespace before that ">".)',
  ],
  [
    "<div x=a + b >c + éin>d</div>",
    '<div> @x ERR(7-21 Ambiguous ">" in attribute. A ">" preceded by whitespace ends the tag. If "a + b >c + éin" was intended as a single expression, wrap it in parentheses, eg "=(a + b >c + éin)". If the tag was instead meant to end at the first ">", leaving "c + éin>" as body content, remove the whitespace before that ">".)',
  ],
  [
    "<div x=a >b / éin>c</div>",
    '<div> @x ERR(7-17 Ambiguous ">" in attribute. A ">" preceded by whitespace ends the tag. If "a >b / éin" was intended as a single expression, wrap it in parentheses, eg "=(a >b / éin)". If the tag was instead meant to end at the first ">", leaving "b / éin>" as body content, remove the whitespace before that ">".)',
  ],
  [
    "<div x=a >éin + b>c</div>",
    '<div> @x ERR(7-17 Ambiguous ">" in attribute. A ">" preceded by whitespace ends the tag. If "a >éin + b" was intended as a single expression, wrap it in parentheses, eg "=(a >éin + b)". If the tag was instead meant to end at the first ">", leaving "éin + b>" as body content, remove the whitespace before that ">".)',
  ],
  ["<div x=a𝑥new y=1/>", '<div> @x ="a𝑥new" @y ="1"'],
  ["<div x=éin! y=1/>", '<div> @x ="éin!" @y ="1"'],
  ["<div x=a newé y=1/>", '<div> @x ="a" @newé @y ="1"'],
  ["<div x=a iné y=1/>", '<div> @x ="a" @iné @y ="1"'],
  ["<div x=typeofé y=1/>", '<div> @x ="typeofé" @y ="1"'],
];

function* inputs(names: readonly string[]): Generator<string> {
  for (const name of names) {
    for (const [pre, post] of POSITIONS) {
      for (const form of FORMS) yield pre + form.replaceAll("K", name) + post;
    }
    for (const t of TEMPLATES) yield t.replaceAll("K", name);
  }
}

/**
 * Each input with a non-ASCII identifier renders as the same input with an
 * ASCII letter of the same length in its place (`swapTwins`). Returns the
 * inputs whose renderings differ (none expected) and how many ran.
 */
export function unicodeWordTwinMismatches(mod: AtomParserModule): {
  total: number;
  bad: string[];
} {
  let total = 0;
  const bad: string[] = [];
  for (const code of inputs(NON_ASCII_NAMES)) {
    total++;
    const wide = renderAtoms(mod, code, true);
    const ascii = swapTwins(
      renderAtoms(mod, swapTwins(code, false), true),
      true,
    );
    if (wide !== ascii) bad.push(`${JSON.stringify(code)}: ${wide}`);
  }
  return { total, bad };
}

/**
 * The ASCII-only sample whose events `mx-unicode-words.main.json` records
 * from main (`4bafe5983`, before this change): the ASCII twins of the inputs
 * above for three names. ASCII-only input must not change.
 */
export function asciiSample(): string[] {
  return [...new Set(inputs(["Q", "aQ", "Qin"]))];
}

/** Returns the sample inputs whose events differ from main's (none expected). */
export function asciiMainMismatches(
  mod: AtomParserModule,
  main: Record<string, string>,
): { total: number; bad: string[] } {
  const bad: string[] = [];
  const sample = asciiSample();
  for (const code of sample) {
    const got = renderAtoms(mod, code, true);
    if (got !== main[code]) bad.push(`${JSON.stringify(code)}: ${got}`);
  }
  return { total: sample.length, bad };
}

/** Events, text and atoms of a parse, for the whitespace twin checks. */
export function renderWhitespaceEvents(
  mod: AtomParserModule & NoThrowParserModule,
  code: string,
): string {
  return `${renderEvents(mod, code)} | ${renderAtoms(mod, code, true)}`;
}

/**
 * Decision 156 addendum 11: the Unicode whitespace and line terminators
 * (`isUnicodeSpaceCode`) behave as ASCII whitespace in every look-behind.
 * Each form puts `W` where a look-behind asks "is this whitespace"; every
 * code point is one UTF-16 unit, like the space, so offsets never shift.
 */
const WS_EXPRESSION_FORMS = [
  // `getPreviousNonWhitespaceCharCode` → `canFollowDivision`.
  "(a)W/ 2",
  "aW/ 2",
  "(é)W/ 2",
  "[a]W/ 2",
  "a / 2W/ 3",
  // The terminator look-behind (`lookBehindWhile` → `lookBehindForOperator`).
  "a +W",
  "a ||W",
  "a ===W",
  "a ?W",
  // The `{` look-behind in a type, `++`/`--`, and `=>` in a type.
  "y as TW{ a: 1 }",
  "a++W+ b",
  "a ++W+b",
  "(a: T)W=> a",
  "a as (T)W=> 1",
];

const WS_POSITIONS: [string, string][] = [
  ["<div x=", "/>"],
  ["<div x=", " y=1/>"],
  ["<div x=", ">b</div>"],
  ["div x=", "\n"],
  ["div x=", " y=1\n"],
  ["<if=", ">y</if>"],
  ["<if(", ")>y</if>"],
  ["<div>${", "}</div>"],
  ["<div x() { return ", " }/>"],
];

/** Inputs outside expressions; `W` is the whitespace. */
const WS_TEMPLATES = [
  // `shouldTerminateHtmlAttrValue`: a whitespace-preceded `>=`.
  "<if=countW>= 10>y</if>",
  "<div x=aW>= b>c</div>",
  // Not `HTML_CONTENT`'s `//` and `/*` in body text: decision 156 addendum
  // 13 withdrew addendum 11 there, see `BODY_TEXT_FORMS`.
];

/**
 * Each input with a Unicode whitespace character in a look-behind position
 * renders as the same input with an ASCII space there (events, text and
 * atoms). Returns the inputs whose renderings differ (none expected).
 */
export function unicodeWhitespaceTwinMismatches(
  mod: AtomParserModule & NoThrowParserModule,
): { total: number; bad: string[] } {
  const inputs: string[] = [];
  for (const [pre, post] of WS_POSITIONS) {
    for (const form of WS_EXPRESSION_FORMS) inputs.push(pre + form + post);
  }
  inputs.push(...WS_TEMPLATES);
  let total = 0;
  const bad: string[] = [];
  for (const ws of UNICODE_WHITESPACE) {
    for (const input of inputs) {
      total++;
      const code = input.replaceAll("W", ws);
      const got = renderWhitespaceEvents(mod, code).replaceAll(ws, " ");
      const twin = renderWhitespaceEvents(mod, input.replaceAll("W", " "));
      if (got !== twin) bad.push(`${JSON.stringify(code)}: ${got}`);
    }
  }
  return { total, bad };
}

/**
 * Decision 156 addendum 11: [input, events | atoms], each Unicode-whitespace
 * input (U+00A0) beside its ASCII-space twin. 22 of these changed from the
 * merge base: division after `)`, a word or a number, the terminator
 * look-behind after an operator, ` >=`, and a comment in HTML text.
 */
export const UNICODE_WHITESPACE_ROWS: [string, string][] = [
  [
    "<div x=(\u00e9)\u00a0/ 2/>",
    '<div> @x ="(\u00e9)\u00a0/ 2" > | <div> @x ="(\u00e9)\u00a0/ 2"',
  ],
  [
    "<div x=(\u00e9) / 2/>",
    '<div> @x ="(\u00e9) / 2" > | <div> @x ="(\u00e9) / 2"',
  ],
  [
    "<div x=(a)\u00a0/ 2/>",
    '<div> @x ="(a)\u00a0/ 2" > | <div> @x ="(a)\u00a0/ 2"',
  ],
  ["<div x=(a) / 2/>", '<div> @x ="(a) / 2" > | <div> @x ="(a) / 2"'],
  ["<div x=a\u00a0/ 2/>", '<div> @x ="a\u00a0/ 2" > | <div> @x ="a\u00a0/ 2"'],
  ["<div x=a / 2/>", '<div> @x ="a / 2" > | <div> @x ="a / 2"'],
  [
    "<div x=a / 2\u00a0/ 3/>",
    '<div> @x ="a / 2\u00a0/ 3" > | <div> @x ="a / 2\u00a0/ 3"',
  ],
  ["<div x=a / 2 / 3/>", '<div> @x ="a / 2 / 3" > | <div> @x ="a / 2 / 3"'],
  [
    "<div x=a +\u00a0/>",
    "<div> @x ERR(11-11 EOF reached while parsing regular expression) | <div> @x ERR(11-11 EOF reached while parsing regular expression)",
  ],
  [
    "<div x=a + />",
    "<div> @x ERR(11-11 EOF reached while parsing regular expression) | <div> @x ERR(11-11 EOF reached while parsing regular expression)",
  ],
  [
    "<div x=a ||\u00a0/>",
    "<div> @x ERR(12-12 EOF reached while parsing regular expression) | <div> @x ERR(12-12 EOF reached while parsing regular expression)",
  ],
  [
    "<div x=a || />",
    "<div> @x ERR(12-12 EOF reached while parsing regular expression) | <div> @x ERR(12-12 EOF reached while parsing regular expression)",
  ],
  [
    "<div x=a +\u00a0 y=1/>",
    '<div> @x ="a +\u00a0 y=1" > | <div> @x ="a +\u00a0 y=1"',
  ],
  ["<div x=a +  y=1/>", '<div> @x ="a +  y=1" > | <div> @x ="a +  y=1"'],
  [
    "<div x=y as T\u00a0{ a: 1 }/>",
    '<div> @x ="y as T\u00a0{ a: 1 }" > | <div> @x ="y as T\u00a0{ a: 1 }"',
  ],
  [
    "<div x=y as T { a: 1 }/>",
    '<div> @x ="y as T { a: 1 }" > | <div> @x ="y as T { a: 1 }"',
  ],
  [
    "<div x=a++\u00a0+ b/>",
    '<div> @x ="a++\u00a0+ b" > | <div> @x ="a++\u00a0+ b"',
  ],
  ["<div x=a++ + b/>", '<div> @x ="a++ + b" > | <div> @x ="a++ + b"'],
  [
    "<div x=(a: T)\u00a0=> a/>",
    '<div> @x ="(a: T)\u00a0=> a" > | <div> @x ="(a: T)\u00a0=> a"',
  ],
  [
    "<div x=(a: T) => a/>",
    '<div> @x ="(a: T) => a" > | <div> @x ="(a: T) => a"',
  ],
  [
    "div x=(\u00e9)\u00a0/ 2\n",
    '<div> @x ="(\u00e9)\u00a0/ 2" > | <div> @x ="(\u00e9)\u00a0/ 2"',
  ],
  [
    "div x=(\u00e9) / 2\n",
    '<div> @x ="(\u00e9) / 2" > | <div> @x ="(\u00e9) / 2"',
  ],
  [
    "div x=(a)\u00a0/ 2\n",
    '<div> @x ="(a)\u00a0/ 2" > | <div> @x ="(a)\u00a0/ 2"',
  ],
  ["div x=(a) / 2\n", '<div> @x ="(a) / 2" > | <div> @x ="(a) / 2"'],
  ["div x=a\u00a0/ 2\n", '<div> @x ="a\u00a0/ 2" > | <div> @x ="a\u00a0/ 2"'],
  ["div x=a / 2\n", '<div> @x ="a / 2" > | <div> @x ="a / 2"'],
  [
    "div x=a / 2\u00a0/ 3\n",
    '<div> @x ="a / 2\u00a0/ 3" > | <div> @x ="a / 2\u00a0/ 3"',
  ],
  ["div x=a / 2 / 3\n", '<div> @x ="a / 2 / 3" > | <div> @x ="a / 2 / 3"'],
  [
    "div x=a +\u00a0\n",
    '<div> @x ="a +\u00a0\\n" > | <div> @x ="a +\u00a0\\n"',
  ],
  ["div x=a + \n", '<div> @x ="a + \\n" > | <div> @x ="a + \\n"'],
  [
    "div x=a ||\u00a0\n",
    '<div> @x ="a ||\u00a0\\n" > | <div> @x ="a ||\u00a0\\n"',
  ],
  ["div x=a || \n", '<div> @x ="a || \\n" > | <div> @x ="a || \\n"'],
  [
    "div x=a +\u00a0 y=1\n",
    '<div> @x ="a +\u00a0 y=1" > | <div> @x ="a +\u00a0 y=1"',
  ],
  ["div x=a +  y=1\n", '<div> @x ="a +  y=1" > | <div> @x ="a +  y=1"'],
  [
    "div x=y as T\u00a0{ a: 1 }\n",
    '<div> @x ="y as T\u00a0{ a: 1 }" > | <div> @x ="y as T\u00a0{ a: 1 }"',
  ],
  [
    "div x=y as T { a: 1 }\n",
    '<div> @x ="y as T { a: 1 }" > | <div> @x ="y as T { a: 1 }"',
  ],
  [
    "div x=a++\u00a0+ b\n",
    '<div> @x ="a++\u00a0+ b" > | <div> @x ="a++\u00a0+ b"',
  ],
  ["div x=a++ + b\n", '<div> @x ="a++ + b" > | <div> @x ="a++ + b"'],
  [
    "div x=(a: T)\u00a0=> a\n",
    '<div> @x ="(a: T)\u00a0=> a" > | <div> @x ="(a: T)\u00a0=> a"',
  ],
  [
    "div x=(a: T) => a\n",
    '<div> @x ="(a: T) => a" > | <div> @x ="(a: T) => a"',
  ],
  [
    "<div>${(\u00e9)\u00a0/ 2}</div>",
    '<div> > ${"(\u00e9)\u00a0/ 2"} </div> | <div> ${"(\u00e9)\u00a0/ 2"}',
  ],
  [
    "<div>${(\u00e9) / 2}</div>",
    '<div> > ${"(\u00e9) / 2"} </div> | <div> ${"(\u00e9) / 2"}',
  ],
  [
    "<div>${(a)\u00a0/ 2}</div>",
    '<div> > ${"(a)\u00a0/ 2"} </div> | <div> ${"(a)\u00a0/ 2"}',
  ],
  ["<div>${(a) / 2}</div>", '<div> > ${"(a) / 2"} </div> | <div> ${"(a) / 2"}'],
  [
    "<div>${a\u00a0/ 2}</div>",
    '<div> > ${"a\u00a0/ 2"} </div> | <div> ${"a\u00a0/ 2"}',
  ],
  ["<div>${a / 2}</div>", '<div> > ${"a / 2"} </div> | <div> ${"a / 2"}'],
  [
    "<div>${a / 2\u00a0/ 3}</div>",
    '<div> > ${"a / 2\u00a0/ 3"} </div> | <div> ${"a / 2\u00a0/ 3"}',
  ],
  [
    "<div>${a / 2 / 3}</div>",
    '<div> > ${"a / 2 / 3"} </div> | <div> ${"a / 2 / 3"}',
  ],
  [
    "<div>${a +\u00a0}</div>",
    '<div> > ${"a +\u00a0"} </div> | <div> ${"a +\u00a0"}',
  ],
  ["<div>${a + }</div>", '<div> > ${"a + "} </div> | <div> ${"a + "}'],
  [
    "<div>${a ||\u00a0}</div>",
    '<div> > ${"a ||\u00a0"} </div> | <div> ${"a ||\u00a0"}',
  ],
  ["<div>${a || }</div>", '<div> > ${"a || "} </div> | <div> ${"a || "}'],
  [
    "<div>${a +\u00a0 y=1}</div>",
    '<div> > ${"a +\u00a0 y=1"} </div> | <div> ${"a +\u00a0 y=1"}',
  ],
  [
    "<div>${a +  y=1}</div>",
    '<div> > ${"a +  y=1"} </div> | <div> ${"a +  y=1"}',
  ],
  [
    "<div>${y as T\u00a0{ a: 1 }}</div>",
    '<div> > ${"y as T\u00a0{ a: 1 }"} </div> | <div> ${"y as T\u00a0{ a: 1 }"}',
  ],
  [
    "<div>${y as T { a: 1 }}</div>",
    '<div> > ${"y as T { a: 1 }"} </div> | <div> ${"y as T { a: 1 }"}',
  ],
  [
    "<div>${a++\u00a0+ b}</div>",
    '<div> > ${"a++\u00a0+ b"} </div> | <div> ${"a++\u00a0+ b"}',
  ],
  ["<div>${a++ + b}</div>", '<div> > ${"a++ + b"} </div> | <div> ${"a++ + b"}'],
  [
    "<div>${(a: T)\u00a0=> a}</div>",
    '<div> > ${"(a: T)\u00a0=> a"} </div> | <div> ${"(a: T)\u00a0=> a"}',
  ],
  [
    "<div>${(a: T) => a}</div>",
    '<div> > ${"(a: T) => a"} </div> | <div> ${"(a: T) => a"}',
  ],
  [
    "<if=count\u00a0>= 10>y</if>",
    '<if> @ ="count\u00a0>= 10" > text:"y" </if> | <if> @ ="count\u00a0>= 10"',
  ],
  [
    "<if=count >= 10>y</if>",
    '<if> @ ="count >= 10" > text:"y" </if> | <if> @ ="count >= 10"',
  ],
  [
    "<div x=a\u00a0>= b>c</div>",
    '<div> @x ="a\u00a0>= b" > text:"c" </div> | <div> @x ="a\u00a0>= b"',
  ],
  [
    "<div x=a >= b>c</div>",
    '<div> @x ="a >= b" > text:"c" </div> | <div> @x ="a >= b"',
  ],
  // Decision 156 addendum 13 (withdrawing addendum 11's confirmed
  // consequence at this site): in a tag body only ASCII whitespace before
  // `//` or `/*` starts a comment, as in Marko. After NBSP the text stays
  // text; its ASCII-space twin below is the comment.
  ["<div>a\u00a0// c\n</div>", '<div> > text:"a\u00a0// c\\n" </div> | <div>'],
  ["<div>a // c\n</div>", '<div> > text:"a " text:"\\n" </div> | <div>'],
  ["<div>a\u00a0/* c */</div>", '<div> > text:"a\u00a0/* c */" </div> | <div>'],
  ["<div>a /* c */</div>", '<div> > text:"a " </div> | <div>'],
];

/**
 * Decision 156 addendum 13, item 1: the body-text inputs where a Unicode
 * whitespace or line terminator character `W` stands before `//` or `/*`.
 */
const BODY_TEXT_FORMS = [
  "<p>VisitW//cdn.example/x.js</p>",
  "<p>VisitW//cdn.example/x.js\n</p>",
  "<div>aW// c\n</div>",
  "<div>aW/* c */</div>",
  "<div>a,W// c\n</div>",
  "<p>aW/* c */ b</p>",
];

/**
 * Each `BODY_TEXT_FORMS` input renders as the same input with a letter
 * where the Unicode whitespace is: no ASCII whitespace, no comment, as in
 * stock htmljs-parser and Marko. All 19 are one UTF-16 unit, like the
 * letter, so offsets never shift. Returns the inputs whose renderings
 * differ (none expected) and how many ran.
 */
export function bodyTextTwinMismatches(
  mod: AtomParserModule & NoThrowParserModule,
): { total: number; bad: string[] } {
  let total = 0;
  const bad: string[] = [];
  for (const ws of UNICODE_WHITESPACE) {
    for (const form of BODY_TEXT_FORMS) {
      total++;
      const code = form.replaceAll("W", ws);
      const got = renderWhitespaceEvents(mod, code).replaceAll(ws, "x");
      const twin = renderWhitespaceEvents(mod, form.replaceAll("W", "x"));
      if (got !== twin) bad.push(`${JSON.stringify(code)}: ${got}`);
    }
  }
  return { total, bad };
}

/** The reported input: a URL after a no-break space is text, `</p>` closes. */
export const BODY_TEXT_ROWS: [string, string][] = [
  [
    "<p>Visit\u00a0//cdn.example/x.js</p>",
    '<p> > text:"Visit\u00a0//cdn.example/x.js" </p> | <p>',
  ],
  [
    "<p>caf\u00e9//cdn.example/x.js</p>",
    '<p> > text:"caf\u00e9//cdn.example/x.js" </p> | <p>',
  ],
];

/**
 * Decision 156 addendum 13, item 2: a code point at or above U+0080 is a word
 * character only when it is `ID_Continue`, or U+200C or U+200D; a surrogate
 * pair is one code point and a lone surrogate is none. Each row is the
 * reading of stock htmljs-parser 5.18.0 (Marko's), measured on the unpatched
 * npm build: a symbol is no identifier, so it is no word in any look-behind
 * or look-ahead.
 */
export const NON_WORD_ROWS: [string, string][] = [
  ["<div x=a >©>c</div>", '<div> @x ="a"'],
  ["<div x=a >× + b>c</div>", '<div> @x ="a"'],
  ["<div x=a >\u{1f600}>c</div>", '<div> @x ="a"'],
  [
    "<div x=© / 2 y=1/>",
    '<div> @x ="© / 2 y=1/" ERR(0-18 Missing ending "div" tag)',
  ],
  ["<div x=×! y=1/>", '<div> @x ="×! y=1"'],
  ["<div x=a.©new b/>", '<div> @x ="a.©new b"'],
  ["<div x=a .© y=1/>", '<div> @x ="a" @.© @y ="1"'],
  ["<div x=a. … y=1/>", '<div> @x ="a." @… @y ="1"'],
  [
    "<if=« / 2>y</if>",
    '<if> @ ="« / 2>y</if" ERR(0-16 Missing ending "if" tag)',
  ],
  [
    "div x=© / 2 y=1\n",
    "<div> @x ERR(8-8 EOL reached while parsing regular expression)",
  ],
  ["<div async ©() { return 1 }/>", '<div> @async @© method:" return 1 "'],
  ["$ type © = A\n<div/>", '$"type © = A" <div>'],
];

/**
 * An atom after a non-identifier symbol lexes, as after ASCII punctuation
 * (`%` here); stock reports an error for both forms. Neither input is valid
 * Marko or JavaScript. Before addendum 13 the symbol was a word character, so
 * `\u00d7:await` read as a key and no atom lexed. Each is pinned beside its
 * ASCII twin.
 */
export const ATOM_AFTER_SYMBOL_ROWS: [string, string, string][] = [
  [
    "=\u00d7:await*/ async</p>",
    "=%:await*/ async</p>",
    '<> @ atom(await@2-8) ="X0.0000*/ async</p>"',
  ],
  [
    "=><div\ud800 :a!<\ud800+,",
    "=><div% :a!<%+,",
    '<> @ atom(a@8-10) ="><divX 0.!<X+,"',
  ],
];

/** Renders `input` and `twin`, the symbol replaced by `X`, and compares both with `expected`. */
export function atomAfterSymbolMismatch(
  mod: AtomParserModule,
  [input, twin, expected]: [string, string, string],
): string[] {
  const norm = (t: string) =>
    t.replace(/[\u0080-\uffff]|\\ud[89a-f][0-9a-f]{2}|%/gi, "X");
  const got = [
    norm(renderAtoms(mod, input, true)),
    norm(renderAtoms(mod, twin, true)),
  ];
  return got.filter((g) => g !== expected);
}

/**
 * Characters at or above U+0080 that are no identifier characters: symbols,
 * punctuation, emoji (a surrogate pair), private use, format characters and
 * U+0085 and U+200B (which TypeScript, unlike ECMAScript and Babel, skips),
 * and surrogates that form no pair (a lone high, a lone low, a low before a
 * high).
 */
const NON_WORD_SYMBOLS = [
  "©",
  "×",
  "÷",
  "…",
  "«",
  "—",
  "€",
  "\u{1f600}",
  "\u{10ffff}",
  "",
  "\u0085",
  "​",
  "‎",
  "⁠",
  "­",
  "᠎",
  "\ud800",
  "\udc00",
  "\udc00\ud800",
  "\ud800a",
];

/**
 * Identifier characters beyond the ones `NON_ASCII_NAMES` has: combining
 * marks, ZWNJ and ZWJ, connector punctuation and `Other_ID_Continue`, a
 * supplementary letter and a supplementary mark.
 */
const EXTRA_WORD_NAMES = [
  "é",
  "a‌",
  "a‍",
  "a‌b",
  "‌a",
  "\u{20bb7}",
  "\u{1d400}",
  "\u{e0100}",
  "a‿",
  "a·",
  "aः",
  "ª",
  "名前",
  "กิ",
];

/**
 * Each input with `names` where the identifier stands renders as the same
 * input with the ASCII `twin` in place of every UTF-16 unit of the name, so
 * offsets never shift (`wide`'s non-ASCII units are mapped to `twin`).
 */
function classTwinMismatches(
  mod: AtomParserModule,
  names: readonly string[],
  twin: string,
): { total: number; bad: string[] } {
  let total = 0;
  const bad: string[] = [];
  for (const code of inputs(names)) {
    total++;
    const ascii = code.replace(/[\u0080-\uffff]/g, twin);
    // `JSON.stringify` writes a lone surrogate as a six character escape.
    const wide = renderAtoms(mod, code, true).replace(
      /[\u0080-\uffff]|\\ud[89a-f][0-9a-f]{2}/gi,
      twin,
    );
    if (wide !== renderAtoms(mod, ascii, true)) {
      bad.push(`${JSON.stringify(code)}: ${wide}`);
    }
  }
  return { total, bad };
}

/** Each `NON_WORD_SYMBOLS` input renders as with ASCII `@`, a non-word. */
export function nonWordTwinMismatches(mod: AtomParserModule) {
  return classTwinMismatches(mod, NON_WORD_SYMBOLS, "@");
}

/** Each `EXTRA_WORD_NAMES` input renders as with ASCII `Q`, a letter. */
export function extraWordTwinMismatches(mod: AtomParserModule) {
  return classTwinMismatches(mod, EXTRA_WORD_NAMES, "Q");
}

/**
 * Decision 156 addendum 15: the after-value `:name` rule's identifier start is
 * ASCII-only, as on main, and stays so while the operator reconsiders
 * `:name` after a value ("on hold"). A non-ASCII name leaves one value, so a
 * later change shows here: `x=1 :é` is one value (a compile error), and an
 * arrow or function expression return type with a non-ASCII name is one
 * valid value, as stock reads it. The ASCII twins split (decision 146).
 */
export const AFTER_VALUE_ON_HOLD_ROWS: [string, string][] = [
  ["<div x=1 :e/>", '<div> @x ="1" @:e'],
  ["<div x=1 :é/>", '<div> @x ="1 :é"'],
  ["<div x=1 :\u{20bb7}/>", '<div> @x ="1 :\u{20bb7}"'],
  [
    "<div x=(a) :T => a/>",
    '<div> @x ="(a)" @:T ERR(15-15 Missing value for attribute)',
  ],
  ["<div x=(a) :É => a/>", '<div> @x ="(a) :É => a"'],
  ["<div x=(a, b) :é => a/>", '<div> @x ="(a, b) :é => a"'],
  ["<div x=async (a) :名 => a/>", '<div> @x ="async (a) :名 => a"'],
  // Function expressions: the ASCII forms split today (stock reads one value).
  [
    "<div x=function (a) :T { return a }/>",
    '<div> @x ="function (a)" @:T @{ return a }',
  ],
  [
    "<div x=function f(a) :T { return a }/>",
    '<div> @x ="function f(a)" @:T @{ return a }',
  ],
  [
    "<div x=async function (a) :T { return a }/>",
    '<div> @x ="async function (a)" @:T @{ return a }',
  ],
  [
    "<div x=function* (a) :T { return a }/>",
    '<div> @x ="function* (a)" @:T @{ return a }',
  ],
  [
    "<div x=function (a) :É { return a }/>",
    '<div> @x ="function (a) :É { return a }"',
  ],
];

/** Each attribute's name and value range, as `@start-end` and `=start-end`. */
export function renderAttrRanges(mod: AtomParserModule, code: string): string {
  const out: string[] = [];
  mod
    .createParser({
      onAttrName: (t: { start: number; end: number }) =>
        out.push(`@${t.start}-${t.end}`),
      onAttrValue: (t: { value: { start: number; end: number } }) =>
        out.push(`=${t.value.start}-${t.value.end}`),
      onError() {},
    })
    .parse(code);
  return out.join(" ");
}

/**
 * Decision 156 addendum 12: in concise mode, `--` after Unicode whitespace
 * starts the text block, as after an ASCII space, but the attribute's range
 * keeps the trailing Unicode whitespace (value `1 `, name `x `):
 * an ASCII space ends the attribute by the current-character test, which is
 * not a look-behind and is not changed. Not equal to the ASCII-space twin,
 * by ruling; these stay out of `unicodeWhitespaceTwinMismatches`.
 * [input, events | atoms, attribute ranges], each beside its twin.
 */
export const CONCISE_DASH_ROWS: [string, string, string][] = [
  [
    "div x=1\u00a0-- text\n",
    '<div> @x ="1\u00a0" > text:"text" | <div> @x ="1\u00a0"',
    "@4-5 =6-8",
  ],
  [
    "div x=1 -- text\n",
    '<div> @x ="1" > text:"text" | <div> @x ="1"',
    "@4-5 =6-7",
  ],
  [
    "div x\u00a0-- text\n",
    '<div> @x\u00a0 > text:"text" | <div> @x\u00a0',
    "@4-6",
  ],
  ["div x -- text\n", '<div> @x > text:"text" | <div> @x', "@4-5"],
  [
    "div x=1\u00a0-- text\n  span\n",
    '<div> @x ="1\u00a0" > text:"text" <span> > | <div> @x ="1\u00a0" <span>',
    "@4-5 =6-8",
  ],
  [
    "div x=1 -- text\n  span\n",
    '<div> @x ="1" > text:"text" <span> > | <div> @x ="1" <span>',
    "@4-5 =6-7",
  ],
  [
    "div x=1\u3000\u00a0-- text\n",
    '<div> @x ="1\u3000\u00a0" > text:"text" | <div> @x ="1\u3000\u00a0"',
    "@4-5 =6-9",
  ],
  [
    "div x=1\u3000 -- text\n",
    '<div> @x ="1\u3000" > text:"text" | <div> @x ="1\u3000"',
    "@4-5 =6-8",
  ],
];
