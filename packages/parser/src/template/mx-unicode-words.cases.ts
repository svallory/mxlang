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
} from "./mx-atoms.cases.ts";

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
