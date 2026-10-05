/**
 * Build-time MX highlighting for the docs site: the tree-sitter MX grammar
 * (`packages/editors/tree-sitter-mx`), the same grammar and the same
 * `queries/highlights.scm` Zed ships, run through web-tree-sitter while the
 * docs build. Nothing parses in the browser; the page gets static spans.
 *
 * This file is two things on purpose, so the landing page's annotated example
 * and an ordinary ```mx fence cannot drift apart:
 *
 *   1. the highlighter (`renderMx`, `spansOf`, `parseMx`), imported by
 *      `scripts/home-example.ts` and by the tests;
 *   2. a docmd plugin (default export, capability `markdown`) that routes every
 *      ```mx fence through `renderMx`. docmd 0.9.5 has no highlight-function
 *      option; `markdownSetup` is the supported way to reach the markdown-it
 *      instance, and overriding `md.options.highlight` (not
 *      `renderer.rules.fence`) keeps docmd's ```lang "title" wrapper working.
 *
 * No silent fallback: when the grammar wasm is missing this module throws at
 * import, so the docs build fails loudly instead of shipping plain text.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, Query } from "web-tree-sitter";

const here = dirname(fileURLToPath(import.meta.url));
const grammarDir = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "editors",
  "tree-sitter-mx",
);
const wasmPath = join(grammarDir, "tree-sitter-mx.wasm");
const highlightsPath = join(grammarDir, "queries", "highlights.scm");

if (!existsSync(wasmPath)) {
  throw new Error(
    `${wasmPath} is missing. The docs highlight \`mx\` code with the tree-sitter grammar and do not fall back to plain text. Build it: \`bun run --cwd packages/editors/tree-sitter-mx build:wasm\` (apps/docs' build, dev and test scripts do this for you).`,
  );
}

await Parser.init();
const mx = await Language.load(wasmPath);
const highlights = new Query(mx, readFileSync(highlightsPath, "utf8"));

/**
 * Capture name -> CSS class. Dots are not valid in a bare class selector, so
 * `punctuation.bracket` becomes `ts-punctuation-bracket`. `none` is the
 * grammar's "deliberately unstyled" (`(text) @none`) and gets no class.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function classOf(name) {
  return name === "none" ? null : `ts-${name.replace(/\./g, "-")}`;
}

/** Every capture name the highlights query can produce. */
export const captureNames = [...new Set(highlights.captureNames)];

/**
 * Parse `source` as MX. A fresh parser per call: a parser holds native state,
 * and a parse is microseconds against a docs build's seconds.
 *
 * @param {string} source
 */
export function parseMx(source) {
  const parser = new Parser();
  try {
    parser.setLanguage(mx);
    const tree = parser.parse(source);
    if (!tree) throw new Error("tree-sitter-mx returned no tree");
    return tree;
  } finally {
    parser.delete();
  }
}

/**
 * The seam for embedded languages. `queries/injections.scm` says which ranges
 * hold TypeScript, CSS or HTML; each language needs its own wasm and
 * highlights query. Return `{ start, end, name }` spans (UTF-16 offsets, the
 * same capture names as the MX query) and `spansOf` folds them in, innermost
 * wins. Until a language is wired here, its range renders as plain code text.
 *
 * @param {import("web-tree-sitter").Tree} _tree
 * @param {string} _source
 * @returns {Array<{ start: number, end: number, name: string }>}
 */
function injectedSpans(_tree, _source) {
  return [];
}

/**
 * One class per character, so overlapping captures resolve deterministically:
 * the narrower range wins, and between equal ranges the later pattern wins
 * (tree-sitter-highlight's rule). On the current query nothing overlaps, so
 * this is a guard for the day a pattern does.
 *
 * @param {string} source
 * @param {import("web-tree-sitter").Tree} [tree]
 * @returns {Array<string | null>} the class of each UTF-16 unit of `source`
 */
export function classesOf(source, tree = parseMx(source)) {
  const found = [
    ...highlights.captures(tree.rootNode).map((capture, order) => ({
      start: capture.node.startIndex,
      end: capture.node.endIndex,
      name: capture.name,
      order,
    })),
    ...injectedSpans(tree, source).map((span, order) => ({
      ...span,
      order: 1e6 + order,
    })),
  ];
  found.sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.order - b.order,
  );
  /** @type {Array<string | null>} */
  const classes = new Array(source.length).fill(null);
  for (const span of found) {
    const cls = classOf(span.name);
    for (let at = span.start; at < span.end; at++) classes[at] = cls;
  }
  return classes;
}

/**
 * The capture spans of `source`: contiguous runs of one class, `null` where
 * the text carries none. Concatenating `text` rebuilds `source`.
 *
 * @param {string} source
 * @returns {Array<{ text: string, cls: string | null }>}
 */
export function spansOf(source) {
  const classes = classesOf(source);
  const spans = [];
  let from = 0;
  for (let at = 1; at <= source.length; at++) {
    if (at === source.length || classes[at] !== classes[from]) {
      spans.push({ text: source.slice(from, at), cls: classes[from] ?? null });
      from = at;
    }
  }
  return spans;
}

/** @param {string} text */
export function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The highlighted inner HTML of `source`.
 *
 * `ownerAt` is how the landing page marks regions: it returns the opening
 * tag of the wrapper that owns a UTF-16 offset (or `""`). Capture spans are
 * cut at every change of owner, then each owned run is wrapped, so a marker
 * that ends inside a token splits that token and the markup stays well nested.
 * Without it the output is exactly what an ordinary fence gets.
 *
 * @param {string} source
 * @param {(offset: number) => string} [ownerAt]
 */
export function renderMx(source, ownerAt = () => "") {
  const classes = classesOf(source);
  let html = "";
  let open = "";
  let at = 0;
  while (at < source.length) {
    const owner = ownerAt(at);
    const cls = classes[at] ?? null;
    let end = at + 1;
    while (
      end < source.length &&
      (classes[end] ?? null) === cls &&
      ownerAt(end) === owner
    ) {
      end++;
    }
    if (owner !== open) {
      if (open) html += "</span>";
      if (owner) html += owner;
      open = owner;
    }
    const text = escapeHtml(source.slice(at, end));
    html += cls ? `<span class="${cls}">${text}</span>` : text;
    at = end;
  }
  if (open) html += "</span>";
  return html;
}

/** The whole `<pre>` an ordinary ```mx fence renders to. */
export function renderFence(source) {
  return `<pre class="hljs mx-hl"><code class="language-mx">${renderMx(source.replace(/\n$/, ""))}</code></pre>`;
}

const WRAPPED = Symbol.for("mxlang.docs.mx-highlight");

/**
 * docmd calls `markdownSetup` twice per markdown processor (before and after
 * its own fence rule), so the wrap is guarded and never stacks.
 *
 * @param {any} md
 */
function markdownSetup(md) {
  if (md.options[WRAPPED]) return;
  md.options[WRAPPED] = true;
  const original = md.options.highlight;
  md.options.highlight = (code, lang, attrs) =>
    lang === "mx" ? renderFence(code) : (original?.(code, lang, attrs) ?? "");
}

export default {
  plugin: {
    name: "mx-highlight",
    version: "0.0.1",
    capabilities: ["markdown"],
  },
  markdownSetup,
};
