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
