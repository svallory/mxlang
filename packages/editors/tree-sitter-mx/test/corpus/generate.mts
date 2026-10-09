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

// htmljs reports an error for these and so must the grammar: each goes to
// errors.txt and is asserted to parse with an ERROR/MISSING node. (Other
// fixtures htmljs rejects are not corpus cases: they are not grammar bugs, the
// grammar is lenient there on purpose or they test htmljs-only recovery.)
const ERROR_FIXTURES = new Set([
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
const add = (
  topic: string,
  name: string,
  source: string,
  tree = "(placeholder)",
) => {
  const list = out.get(topic) ?? [];
  // errors.txt holds the cases tree-sitter's `:error` attribute marks: the
  // source must parse with an ERROR/MISSING node. tree-sitter does not compare
  // the tree of such a case (and `--update` leaves it alone), so the generator
  // writes the tree the grammar gives, as documentation.
  const attr = topic === "errors" ? ":error\n" : "";
  list.push(
    `===============\n${name}\n${attr}===============\n${source}\n---------------\n\n${tree}\n`,
  );
  out.set(topic, list);
};

const D = await fixturesDir();
let kept = 0;
for (const entry of fs.readdirSync(D).sort()) {
  const input = path.join(D, entry, "input.marko");
  if (!fs.existsSync(input)) continue;
  const source = fs.readFileSync(input, "utf-8");
  const tree = parseMx(source);
  if (ERROR_FIXTURES.has(entry)) {
    if (!tree?.rootNode.hasError)
      throw new Error(`${entry}: htmljs rejects it, the grammar must too`);
    add("errors", entry, source, tree.rootNode.toString());
    kept++;
    continue;
  }
  const snaps = fs.readdirSync(path.join(D, entry, "__snapshots__"));
  const hasError = snaps.some((s) =>
    fs
      .readFileSync(path.join(D, entry, "__snapshots__", s), "utf-8")
      .includes("error("),
  );
  if (hasError) continue;
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
