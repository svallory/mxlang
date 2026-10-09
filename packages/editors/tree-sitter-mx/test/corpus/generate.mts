// Regenerates test/corpus/*.txt (sources only; the expected trees come from
// `tree-sitter test --update`). Run from the package: `bun test/corpus/generate.mts`.
//
// Two sources: the htmljs-parser v5.12.0 fixtures (MIT, see README.md), kept
// when the wasm grammar parses them without an ERROR/MISSING node and htmljs
// itself reports no error; and MX's own cases in EXTRA below.
import fs from "node:fs";
import path from "node:path";
import { fixturesDir } from "../../__tests__/util/htmljs.mts";
import { parseMx } from "../../__tests__/util/language.mts";
import { CORPUS_DIR, parseCorpus } from "./read.mts";

const TOPICS: [string, RegExp][] = [
  ["placeholders", /^(placeholder|ignorePlaceholders|template|backtick)/],
  ["scriptlets", /^(scriptlet|statement|semicolon|root|var)/],
  ["attributes", /^(attr|argument|commas|default|shorthand|complex|unary)/],
  [
    "tags",
    /^(tag|self|mixed|nested|open|html|concise|whitespace|ts|stray|mismatched|empty)/,
  ],
  [
    "text",
    /^(text|multiline|parsed|single|double|regexp|division|css|comment|script|cdata|xml|dtd|declaration|double-hyphen)/,
  ],
];
const topicOf = (name: string) =>
  TOPICS.find(([, re]) => re.test(name))?.[0] ?? "misc";

// Grammar accepts these although htmljs reports an error for them: grammar
// bugs, kept out of the corpus (listed in scratch/reports).
const GRAMMAR_BUGS = new Set([
  "cdata-eof",
  "eof-doctype",
  "eof-xml-declaration",
  "html-comment-eof",
  "invalid-code-after-comment-block",
  "invalid-line-start-hyphen",
  "invalid-line-start-slash",
]);

const EXTRA: Record<string, [string, string][]> = {
  "mx-comments": [
    ["html comment", "<!-- a -->\n<div/>\n"],
    ["js line comment in concise attrs", 'div class="a" // note\n'],
    ["js block comment between attributes", '<div /* c */ class="a"/>\n'],
    ["comment inside body", "<div>\n  <!-- inner -->\n  hi\n</div>\n"],
  ],
  "mx-tags": [
    [
      "html and concise tags",
      "<div>\n  <span>x</span>\n</div>\nul\n  li -- one\n",
    ],
    ["shorthand id and class", "<div#main.big.small/>\ndiv#main.big\n"],
    ["name sugar", "<string :title/>\nstring :title\n"],
    [
      "if and for",
      "<if=x>\n  <for|i| of=list>\n    <li>${i}</li>\n  </for>\n</if>\n",
    ],
    [
      "attribute tags",
      "<card>\n  <@header>Title</@header>\n  <@body>Text</@body>\n</card>\n",
    ],
    ["text placeholder", "<p>Hello ${name}!</p>\n"],
    ["import", 'import { a } from "./a.mx"\n<a/>\n'],
  ],
  "mx-atoms": [
    ["whole-value atom", "<x mode=:strict/>\n"],
    ["atom in expression", "<x mode=(on ? :a : :b)/>\n"],
  ],
};

const out = new Map<string, string[]>();
const add = (topic: string, name: string, source: string) => {
  const list = out.get(topic) ?? [];
  list.push(
    `===============\n${name}\n===============\n${source}\n---------------\n\n(placeholder)\n`,
  );
  out.set(topic, list);
};

const D = await fixturesDir();
let kept = 0;
for (const entry of fs.readdirSync(D).sort()) {
  if (GRAMMAR_BUGS.has(entry)) continue;
  const input = path.join(D, entry, "input.marko");
  if (!fs.existsSync(input)) continue;
  const snaps = fs.readdirSync(path.join(D, entry, "__snapshots__"));
  const hasError = snaps.some((s) =>
    fs
      .readFileSync(path.join(D, entry, "__snapshots__", s), "utf-8")
      .includes("error("),
  );
  if (hasError) continue;
  const source = fs.readFileSync(input, "utf-8");
  const tree = parseMx(source);
  if (!tree || tree.rootNode.hasError) continue;
  add(topicOf(entry), entry, source);
  kept++;
}
const mesh = fs.readFileSync(
  path.join(CORPUS_DIR, "../fixtures/mesh-invoice.mx"),
  "utf-8",
);
add("mx-mesh", "mesh-invoice", mesh);
for (const [topic, cases] of Object.entries(EXTRA))
  for (const [n, s] of cases) add(topic, n, s);

for (const [topic, cases] of out) {
  const text = cases.join("\n");
  fs.writeFileSync(path.join(CORPUS_DIR, `${topic}.txt`), text);
  // The reader must give back exactly the source that went in.
  parseCorpus(`${topic}.txt`, text);
}
console.log(`htmljs cases kept: ${kept}`);
