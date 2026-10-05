/**
 * Build-time MX highlighting for docmd sites (`@mxlang/tree-sitter-mx/docmd`):
 * the tree-sitter MX grammar (`packages/editors/tree-sitter-mx`), the same
 * grammar and the same `queries/highlights.scm` Zed ships, run through
 * web-tree-sitter while the docs build. Nothing parses in the browser; the page gets static spans.
 *
 * This file is two things on purpose, so the landing page's annotated example
 * and an ordinary ```mx fence cannot drift apart:
 *
 *   1. the highlighter (`renderMx`, `spansOf`, `parseMx`), imported by
 *      the mx docs' `scripts/home-example.ts` and its tests;
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
const grammarDir = join(here, "..");
const wasmPath = join(grammarDir, "tree-sitter-mx.wasm");
const highlightsPath = join(grammarDir, "queries", "highlights.scm");
const injectionsPath = join(grammarDir, "queries", "injections.scm");
/** Built by `build-ts-grammar.sh` (the package's `prepack` runs it). */
const tsDir = join(here, "ts");
const tsWasmPath = join(tsDir, "tree-sitter-typescript.wasm");
const tsHighlightsPath = join(tsDir, "highlights.scm");

const BUILD =
  "bun run --cwd packages/editors/tree-sitter-mx build:wasm && bash packages/editors/tree-sitter-mx/highlight/build-ts-grammar.sh";
for (const path of [wasmPath, tsWasmPath, tsHighlightsPath]) {
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing. MX code is highlighted with the tree-sitter grammars and there is no fallback to plain text. A published @mxlang/tree-sitter-mx ships these files, so reinstall it; in the mx repository build them with \`${BUILD}\` (apps/docs' build, dev and test scripts do this for you via \`build:wasm\`).`,
    );
  }
}

await Parser.init();
const mx = await Language.load(wasmPath);
const typescript = await Language.load(tsWasmPath);
const highlights = new Query(mx, readFileSync(highlightsPath, "utf8"));
const injections = new Query(mx, readFileSync(injectionsPath, "utf8"));
const tsHighlights = new Query(
  typescript,
  readFileSync(tsHighlightsPath, "utf8"),
);

/**
 * The languages `injections.scm` can name that this build can highlight. Add
 * one by loading its wasm and highlights query here and giving it an entry;
 * `injectedSpans` does the rest. `css` and `html` are in `injections.scm` too
 * (`<style>`, html comments) and render as plain code text until they are.
 */
const injectable = new Map([
  ["typescript", { language: typescript, query: tsHighlights }],
]);

/**
 * Capture name -> CSS class. Dots are not valid in a bare class selector, so
 * `punctuation.bracket` becomes `ts-punctuation-bracket`. `none` is the
 * grammar's "deliberately unstyled" (`(text) @none`) and gets no class, and
 * neither does `embedded` (the JavaScript query's template-substitution
 * marker, which only says "inner captures decide").
 *
 * @param {string} name
 * @returns {string | null}
 */
export function classOf(name) {
  return name === "none" || name === "embedded"
    ? null
    : `ts-${name.replace(/\./g, "-")}`;
}

/** Every capture name the MX and the injected-language queries can produce. */
export const captureNames = [
  ...new Set([...highlights.captureNames, ...tsHighlights.captureNames]),
];

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
 * The embedded-language seam: highlight what `queries/injections.scm` says is
 * another language. Each match names a content node and, through `#set!`, a
 * language; the languages in `injectable` are parsed over exactly the content
 * ranges (the node, minus its children unless `injection.include-children`)
 * with `includedRanges`, then captured with that language's own query. Spans
 * are UTF-16 offsets into `source`, like every other span. A language that is
 * not in `injectable` renders as plain code text.
 *
 * `injection.combined` is not honoured: each region is parsed on its own, so a
 * construct split across two `<script>` bodies would be seen as two programs.
 *
 * @param {import("web-tree-sitter").Tree} tree
 * @param {string} source
 * @returns {Array<{ start: number, end: number, name: string }>}
 */
function injectedSpans(tree, source) {
  /** @type {Map<string, { language: string, ranges: Array<[number, number]> }>} */
  const regions = new Map();
  for (const match of injections.matches(tree.rootNode)) {
    const language = match.setProperties?.["injection.language"];
    const content = match.captures.find(
      (capture) => capture.name === "injection.content",
    )?.node;
    if (!language || !content || !injectable.has(language)) continue;
    /** @type {Array<[number, number]>} */
    let ranges = [[content.startIndex, content.endIndex]];
    if (!("injection.include-children" in (match.setProperties ?? {}))) {
      ranges = [];
      let from = content.startIndex;
      for (const child of content.children) {
        if (child.startIndex > from) ranges.push([from, child.startIndex]);
        from = Math.max(from, child.endIndex);
      }
      if (from < content.endIndex) ranges.push([from, content.endIndex]);
    }
    if (ranges.length) {
      regions.set(`${language}:${JSON.stringify(ranges)}`, {
        language,
        ranges,
      });
    }
  }

  const lineStarts = [0];
  for (let at = 0; at < source.length; at++) {
    if (source[at] === "\n") lineStarts.push(at + 1);
  }
  /** @param {number} index */
  const pointAt = (index) => {
    let row = 0;
    while (row + 1 < lineStarts.length && (lineStarts[row + 1] ?? 0) <= index) {
      row++;
    }
    return { row, column: index - (lineStarts[row] ?? 0) };
  };

  const spans = [];
  for (const { language, ranges } of regions.values()) {
    const target = injectable.get(language);
    if (!target) continue;
    const parser = new Parser();
    try {
      parser.setLanguage(target.language);
      const injected = parser.parse(source, null, {
        includedRanges: ranges.map(([start, end]) => ({
          startIndex: start,
          endIndex: end,
          startPosition: pointAt(start),
          endPosition: pointAt(end),
        })),
      });
      if (!injected) continue;
      for (const capture of target.query.captures(injected.rootNode)) {
        spans.push({
          start: capture.node.startIndex,
          end: capture.node.endIndex,
          name: capture.name,
        });
      }
    } finally {
      parser.delete();
    }
  }
  return spans;
}

/**
 * One class per character, so overlapping captures resolve deterministically:
 * the narrower range wins, and between equal ranges the later pattern wins
 * (tree-sitter-highlight's rule). The MX query is painted first and an
 * injected language's captures refine it; the MX query alone never overlaps.
 *
 * @param {string} source
 * @param {import("web-tree-sitter").Tree} [tree]
 * @returns {Array<string | null>} the class of each UTF-16 unit of `source`
 */
export function classesOf(source, tree = parseMx(source)) {
  const own = highlights.captures(tree.rootNode).map((capture, order) => ({
    start: capture.node.startIndex,
    end: capture.node.endIndex,
    name: capture.name,
    order,
  }));
  const injected = injectedSpans(tree, source).map((span, order) => ({
    ...span,
    order,
  }));
  const narrowestFirst = (a, b) =>
    b.end - b.start - (a.end - a.start) || a.order - b.order;
  /** @type {Array<string | null>} */
  const classes = new Array(source.length).fill(null);
  for (const span of own.sort(narrowestFirst)) {
    const cls = classOf(span.name);
    for (let at = span.start; at < span.end; at++) classes[at] = cls;
  }
  // The JavaScript query's catch-all `(identifier) @variable` would otherwise
  // repaint a binding the MX query already knows is a parameter or a type, so
  // an injected plain `variable` only fills text that has no class yet.
  for (const span of injected.sort(narrowestFirst)) {
    const cls = classOf(span.name);
    for (let at = span.start; at < span.end; at++) {
      if (span.name === "variable" && classes[at]) continue;
      classes[at] = cls;
    }
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
