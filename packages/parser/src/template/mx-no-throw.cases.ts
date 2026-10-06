// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the cases are MX source, whose `${…}` is a placeholder, not a JS template
/**
 * template-parser-comment-in-text-tag-open-crash: the template parser never
 * throws; any internal failure is an `onError` (mx-lead ruling). Run against
 * this source copy (`mx-no-throw.test.ts`) and both patched npm builds
 * (`patches/htmljs-parser.test.ts`).
 */

/** The structural subset of a parser module these cases drive. */
export interface NoThrowParserModule {
  createParser(handlers: Record<string, unknown>): {
    parse(code: string): void;
    read(range: { start: number; end: number }): string;
  };
  TagType: { text: number; statement: number };
}

interface ValueRange {
  start: number;
  end: number;
  value: { start: number; end: number };
}

const TEXT_TAGS = new Set(["script", "style", "textarea"]);

/**
 * Parses `code` with `script`, `style` and `textarea` as text tags (as
 * `@marko/compiler` returns them from `onOpenTagName`) and `static` as a
 * statement, and renders the events compactly; a throw renders as
 * `THROW(message)`.
 */
export function renderEvents(mod: NoThrowParserModule, code: string): string {
  const out: string[] = [];
  const show = (r: { start: number; end: number }) =>
    JSON.stringify(parser.read(r));
  const parser = mod.createParser({
    onError: (e: { start: number; end: number; message: string }) =>
      out.push(`ERR(${e.start}-${e.end} ${e.message})`),
    onOpenTagName: (t: { start: number; end: number }) => {
      const name = code.slice(t.start, t.end);
      out.push(`<${name}>`);
      if (TEXT_TAGS.has(name)) return mod.TagType.text;
      if (name === "static") return mod.TagType.statement;
    },
    onOpenTagEnd: () => out.push(">"),
    onCloseTagName: (t: { start: number; end: number }) =>
      out.push(`</${code.slice(t.start, t.end)}>`),
    onTagArgs: (t: ValueRange) => out.push(`args:${show(t.value)}`),
    onTagVar: (t: ValueRange) => out.push(`var:${show(t.value)}`),
    onAttrName: (t: { start: number; end: number }) =>
      out.push(`@${code.slice(t.start, t.end)}`),
    onAttrValue: (t: ValueRange) => out.push(`=${show(t.value)}`),
    onText: (t: { start: number; end: number }) => out.push(`text:${show(t)}`),
    onPlaceholder: (t: ValueRange) => out.push(`\${${show(t.value)}}`),
  });
  try {
    parser.parse(code);
  } catch (e) {
    out.push(`THROW(${(e as Error).message})`);
  }
  return out.join(" ");
}

/**
 * [input, rendered events]: a `//` or `/*` comment inside a text tag's open
 * tag is part of that open tag's expression, never the body's close-tag
 * check (it used to emit `</script>` there and then throw); a comment in the
 * body still closes the tag as before.
 */
export const NO_THROW_ROWS: [string, string][] = [
  [
    "<script x=1 // </script>\n>a</script>",
    '<script> @x ="1 // </script>" > text:"a" </script>',
  ],
  [
    "<script x=1 /* </script> */>a</script>",
    '<script> @x ="1 /* </script> */" > text:"a" </script>',
  ],
  [
    "<style x=1 // </style>\n>a{}</style>",
    '<style> @x ="1 // </style>" > text:"a{}" </style>',
  ],
  [
    "<textarea x=1 // </textarea>\n>a</textarea>",
    '<textarea> @x ="1 // </textarea>" > text:"a" </textarea>',
  ],
  [
    "<script x=1 // </script>\n y=2>a</script>",
    '<script> @x ="1 // </script>" @y ="2" > text:"a" </script>',
  ],
  [
    "<script x=(1 // </script>\n)>a</script>",
    '<script> @x ="(1 // </script>\\n)" > text:"a" </script>',
  ],
  [
    "<script(a // </script>\n)>b</script>",
    '<script> args:"a // </script>\\n" > text:"b" </script>',
  ],
  [
    "<script/x // </script>\n>a</script>",
    '<script> var:"x // </script>" > text:"a" </script>',
  ],
  [
    "<script x=`${1 // </script>\n}`>a</script>",
    '<script> @x ="`${1 // </script>\\n}`" > text:"a" </script>',
  ],
  [
    "script x=1 // </script>\n  -- a\n",
    '<script> @x ="1 // </script>" > text:"a"',
  ],
  [
    "<script x=1 // </script>",
    '<script> @x ERR(10-10 EOF reached while parsing attribute value for the "x" attribute)',
  ],
  [
    "<script x=1 // </script>\n",
    '<script> @x ="1 // </script>" ERR(0-0 EOF reached while parsing open tag)',
  ],
  ["<script>// </script>", '<script> > text:"// " </script>'],
  ["<script>a // </script>", '<script> > text:"a // " </script>'],
  [
    "<script>/* </script> */</script>",
    '<script> > text:"/* </script> */" </script>',
  ],
  [
    "<script>${a // </script>\n}</script>",
    '<script> > </script> ${"a // </script>"} text:"}</script>"',
  ],
  ["<style>// </style>", '<style> > text:"// " </style>'],
  ["<textarea>// </textarea>", '<textarea> > text:"// " </textarea>'],
  ["</script>", 'ERR(0-9 The closing "script" tag was not expected)'],
  ["<div>// </div>", '<div> > text:"// " </div>'],
];

/** A deterministic 32-bit PRNG (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The parser's delimiter alphabet, plus names that switch its modes. */
const TOKENS = [
  "<",
  ">",
  "/",
  "/>",
  "</",
  "!",
  "-",
  "--",
  "=",
  ":",
  "::",
  ".",
  "#",
  "|",
  ",",
  ";",
  "?",
  "*",
  '"',
  "'",
  "`",
  "${",
  "$!{",
  "}",
  "{",
  "(",
  ")",
  "[",
  "]",
  "//",
  "/*",
  "*/",
  "<!--",
  "-->",
  "<![CDATA[",
  "]]>",
  "\n",
  "\r\n",
  " ",
  "  ",
  "\t",
  "a",
  "x",
  "1",
  "é",
  "script",
  "style",
  "textarea",
  "static",
  "if",
  "for",
  "@a",
  "...",
  "$ ",
  "<script",
  "</script>",
  "<style",
  "</style>",
  "html-comment",
  "async",
  "type ",
  "as",
  "in",
];

/**
 * Generates `count` inputs from `TOKENS` with `seed` (each 1 to 40 tokens)
 * and returns the ones whose parse throws, with the thrown message (none
 * expected).
 */
export function fuzzThrows(
  mod: NoThrowParserModule,
  seed: number,
  count: number,
): { total: number; thrown: string[] } {
  const next = random(seed);
  const thrown: string[] = [];
  for (let n = 0; n < count; n++) {
    const length = 1 + Math.floor(next() * 40);
    let code = "";
    for (let k = 0; k < length; k++) {
      code += TOKENS[Math.floor(next() * TOKENS.length)];
    }
    const out = renderEvents(mod, code);
    const at = out.indexOf("THROW(");
    if (at !== -1) thrown.push(`${JSON.stringify(code)} ${out.slice(at)}`);
  }
  return { total: count, thrown };
}

/**
 * Every `onError` of a parse as `code@start-end`, or `THROW(message)`.
 */
export function renderErrorCodes(
  mod: NoThrowParserModule,
  code: string,
): string {
  const out: string[] = [];
  const parser = mod.createParser({
    onError: (e: { code: number; start: number; end: number }) =>
      out.push(`${e.code}@${e.start}-${e.end}`),
  });
  try {
    parser.parse(code);
  } catch (e) {
    out.push(`THROW(${(e as Error).message})`);
  }
  return out.join(" ");
}

/**
 * template-parser-lookbehinds-followup, item 1: [input, rendered events,
 * error codes]. A `,` opens a tag that never gets its name, and a concise
 * `--` line follows; a named closing tag after it used to throw out of
 * `ensureExpectedCloseTag` (`activeTag.tagName.end`). It is
 * `EXTRA_CLOSING_TAG` (0), as `-- </e>` already is. The neighbours that did
 * not throw keep their events: `</>` still closes the nameless tag, and
 * every other concise text line, stray close tag and open parent is as
 * before.
 */
export const STRAY_CLOSE_ROWS: [string, string, string][] = [
  [",--/</e>", '> ERR(4-8 The closing "e" tag was not expected)', "0@4-8"],
  [",--/</e>\n", '> ERR(4-8 The closing "e" tag was not expected)', "0@4-8"],
  [
    ",-- /</e>",
    '> text:"/" ERR(5-9 The closing "e" tag was not expected)',
    "0@5-9",
  ],
  [
    ",--\n/</e>",
    '> text:"/" ERR(5-9 The closing "e" tag was not expected)',
    "0@5-9",
  ],
  [
    ",--/</div>",
    '> ERR(4-10 The closing "div" tag was not expected)',
    "0@4-10",
  ],
  [
    ",--/</script>",
    '> ERR(4-13 The closing "script" tag was not expected)',
    "0@4-13",
  ],
  [",--/</e>/</f>", '> ERR(4-8 The closing "e" tag was not expected)', "0@4-8"],
  [",,--/</e>", '> ERR(5-9 The closing "e" tag was not expected)', "0@5-9"],
  [",--/</e>>", '> ERR(4-8 The closing "e" tag was not expected)', "0@4-8"],
  [", --/</e>", '> ERR(5-9 The closing "e" tag was not expected)', "0@5-9"],
  [",--/</>", "> </>", ""],
  [
    ",-- x\n/</e>",
    '> text:"x" ERR(6-6 A line in concise mode cannot start with "/" unless it starts a "//" or "/*" comment)',
    "8@6-6",
  ],
  [",--", ">", ""],
  [",-- x", '> text:"x"', ""],
  [
    ";--/</e>",
    "> ERR(1-1 A semicolon indicates the end of a line. Only comments may follow it.)",
    "5@1-1",
  ],
  [
    "div\n  ,--/</e>",
    '<div> > ERR(10-14 The closing "e" tag does not match the corresponding opening "div" tag)',
    "21@10-14",
  ],
  [
    "<div>,--/</e></div>",
    '<div> > text:",--/" ERR(9-13 The closing "e" tag does not match the corresponding opening "div" tag)',
    "21@9-13",
  ],
  [
    "<div>\n,--/</e>\n</div>",
    '<div> > text:"\\n,--/" ERR(10-14 The closing "e" tag does not match the corresponding opening "div" tag)',
    "21@10-14",
  ],
  ["--/</e>", 'ERR(3-7 The closing "e" tag was not expected)', "0@3-7"],
  ["-- </e>", 'ERR(3-7 The closing "e" tag was not expected)', "0@3-7"],
  [
    ",/</e>",
    "<> ERR(2-2 A slash was found that was not followed by a variable name or lhs expression)",
    "23@2-2",
  ],
  ["</e>", 'ERR(0-4 The closing "e" tag was not expected)', "0@0-4"],
  [
    "div\n  -- a\n</e>",
    '<div> > text:"a" ERR(11-15 The closing "e" tag was not expected)',
    "0@11-15",
  ],
  [
    "a,--/</e>",
    '<a> > ERR(5-9 The closing "e" tag does not match the corresponding opening "a" tag)',
    "21@5-9",
  ],
  ["<a>\n,--/</a>", '<a> > text:"\\n,--/" </a>', ""],
];

/**
 * The shapes the stray close tag needs: lines (concise mode) that start with
 * a separator or a `--` text block, each followed by a few tokens.
 */
const LINE_STARTS = [
  ",",
  ", ",
  ",,",
  ";",
  "--",
  "-- ",
  ",--",
  ",-- ",
  "  ",
  "div",
  "a,",
  "-",
];

/**
 * Like `fuzzThrows`, but builds each input as 1 to 6 concise lines: an
 * optional indent, a `LINE_STARTS` entry, then 0 to 8 `TOKENS`.
 */
export function fuzzLineThrows(
  mod: NoThrowParserModule,
  seed: number,
  count: number,
): { total: number; thrown: string[] } {
  const next = random(seed);
  const pick = <T>(list: readonly T[]) =>
    list[Math.floor(next() * list.length)] as T;
  const thrown: string[] = [];
  for (let n = 0; n < count; n++) {
    const lines: string[] = [];
    const lineCount = 1 + Math.floor(next() * 6);
    for (let l = 0; l < lineCount; l++) {
      let line = next() < 0.3 ? "  " : "";
      line += pick(LINE_STARTS);
      const tokens = Math.floor(next() * 9);
      for (let k = 0; k < tokens; k++) line += pick(TOKENS);
      lines.push(line);
    }
    const code = lines.join("\n");
    const out = renderEvents(mod, code);
    const at = out.indexOf("THROW(");
    if (at !== -1) thrown.push(`${JSON.stringify(code)} ${out.slice(at)}`);
  }
  return { total: count, thrown };
}

/**
 * template-parser-nameless-tag-throw (decision 156 addendum 13, item 5):
 * [input, rendered events]. A tag that never got its name and is still open
 * at the end of the input is `MISSING_END_TAG` (22), named as the default
 * `div`, as `ensureExpectedCloseTag` names it; it used to throw
 * `range.start` out of `parse()` (`htmlEOF`).
 */
export const NAMELESS_TAG_ROWS: [string, string][] = [
  ["<,>a", '> text:"a" ERR(0-3 Missing ending "div" tag)'],
  ["--#'!<,\r\n>", `text:"'!" > ERR(5-10 Missing ending "div" tag)`],
  ["<,>", '> ERR(0-3 Missing ending "div" tag)'],
  ["<div><,>", '<div> > > ERR(5-8 Missing ending "div" tag)'],
  ["<,>/>\n  ", '> text:"/>\\n  " ERR(0-3 Missing ending "div" tag)'],
  ["div\n  <,>x", '<div> > > text:"x" ERR(6-9 Missing ending "div" tag)'],
  // A tag whose name is EMPTY, not missing, never threw and keeps its message
  // byte for byte (an empty name reads as ""), the base's reading.
  ["<#i>", '<> > ERR(0-4 Missing ending "" tag)'],
  ["<,#i>", '<> > ERR(0-5 Missing ending "" tag)'],
  ["<,.c>", '<> > ERR(0-5 Missing ending "" tag)'],
  ["<,/v>a", '<> var:"v" > text:"a" ERR(0-5 Missing ending "" tag)'],
  ["<,|p|>a", '<> > text:"a" ERR(0-6 Missing ending "" tag)'],
  ["<,(a)>a", '<> args:"a" > text:"a" ERR(0-6 Missing ending "" tag)'],
  // Pinned as they were: the shapes that never threw.
  [",", ">"],
  ["<,/>", ">"],
  [",--", ">"],
  ["</>", 'ERR(0-3 The closing "" tag was not expected)'],
];

/**
 * template-parser-nameless-tag-throw (decision 156 addendum 13, item 5): the
 * tags that never get a name. A `,` line, `<,>`, `<,/>`, a `</>` and head
 * parts (an attribute, shorthand, argument or variable) before any name, with
 * a comment before a name, each inside and outside a parent, HTML and
 * concise.
 */
const NAMELESS_PIECES = [
  ",",
  ", ",
  ",,",
  "<,>",
  "<,/>",
  "<,",
  "<, x=1>",
  "<,/v>",
  "<,(a)>",
  "<,|p|>",
  "</>",
  "</,>",
  "</",
  "<>",
  "< >",
  "<//>",
  "<.a>",
  "<#b>",
  "<,#i>",
  "<,.c>",
  "<#i/>",
  "<,#i/>",
  "#i",
  ".c",
  "<:c>",
  "<x=1>",
  "<(a)>",
  "<|p|>",
  "<=1>",
  "<// c\n>",
  "</* c */>",
  "<!-- c -->",
  "// c",
  "/* c */",
  "x=1",
  ".a",
  "#b",
  "(a)",
  "/v",
  "|p|",
  "=1",
  "--",
  "-- t",
  "--/",
  ">",
  "/>",
  "/",
  "div",
  "<div>",
  "</div>",
  "<div/>",
  "a",
  "<a>",
  "</a>",
  "script",
  "<script>",
  "</script>",
  "static",
  "<static>",
  "\n",
  "\n  ",
  "\n    ",
  " ",
  "\t",
  "${a}",
  "$ x",
  ";",
  "{",
  "}",
];

/** Openers that put the nameless piece inside a parent, in both syntaxes. */
const NAMELESS_PARENTS = [
  "",
  "",
  "<div>",
  "div\n  ",
  "<div>\n",
  "<a><b>",
  "a\n  b\n    ",
  "<script>",
];

/**
 * `count` inputs of 1 to 8 `NAMELESS_PIECES` after an optional parent, from
 * `seed`: tags that never got a name (`<,>`) and tags whose name is empty
 * (`<#i>`, `<,.c>`), all ASCII.
 */
export function namelessInputs(seed: number, count: number): string[] {
  const next = random(seed);
  const pick = <T>(list: readonly T[]) =>
    list[Math.floor(next() * list.length)] as T;
  const inputs: string[] = [];
  for (let n = 0; n < count; n++) {
    let code = pick(NAMELESS_PARENTS);
    const pieces = 1 + Math.floor(next() * 8);
    for (let k = 0; k < pieces; k++) code += pick(NAMELESS_PIECES);
    if (next() < 0.2) code += pick(NAMELESS_PIECES);
    inputs.push(code);
  }
  return inputs;
}

/**
 * Parses `namelessInputs(seed, count)` and returns the ones whose parse
 * throws, with the thrown message (none expected).
 */
export function fuzzNamelessThrows(
  mod: NoThrowParserModule,
  seed: number,
  count: number,
): { total: number; thrown: string[] } {
  const thrown: string[] = [];
  for (const code of namelessInputs(seed, count)) {
    const out = renderEvents(mod, code);
    const at = out.indexOf("THROW(");
    if (at !== -1) thrown.push(`${JSON.stringify(code)} ${out.slice(at)}`);
  }
  return { total: count, thrown };
}

/**
 * ASCII-only input must not change. The inputs of `mx-nameless-ascii.main.json`
 * are `namelessInputs(7, 3000)` with the events recorded from main
 * (`e389c383d`, before the word-class and nameless-tag fixes), biased to the
 * tags without a name and with an empty name that the corpus and a generic
 * ASCII fuzz barely reach (the empty-name message of review B1 was missed by
 * both). Returns the inputs whose events differ from the recording; an input
 * that threw on main only has to stop throwing.
 */
export function namelessAsciiMismatches(
  mod: NoThrowParserModule,
  main: Record<string, string>,
): { total: number; bad: string[] } {
  const bad: string[] = [];
  const inputs = Object.keys(main);
  for (const code of inputs) {
    const got = renderEvents(mod, code);
    const was = main[code] as string;
    if (was.includes("THROW(")) {
      if (got.includes("THROW(")) bad.push(`${JSON.stringify(code)}: ${got}`);
    } else if (got !== was) bad.push(`${JSON.stringify(code)}: ${got}`);
  }
  return { total: inputs.length, bad };
}
