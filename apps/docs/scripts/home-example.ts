/**
 * The home page's `.mx` example: one file, its markers, and the HTML the
 * landing page ships.
 *
 * Three jobs, in order, and all three are gates rather than conveniences:
 * the example must compile on the html target (`@mxlang/html`, the same
 * entry `packages/targets/html/src/example.ts` uses), every marker must
 * still point at the text it was written for, and every marker link must
 * name a page that exists. A home page that shows syntax the language
 * rejects, or a marker one line out of date, is worse than no home page —
 * so `build-home.ts` fails the docs build instead of publishing one.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MxWarning } from "@mxlang/core";
import { scanCached } from "@mxlang/core";
import { compileFile, htmlTargets } from "@mxlang/html";
import { escapeHtml, parseMx, renderMx } from "../plugins/mx-highlight.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** `apps/docs` — the docmd project root. */
export const docsRoot = join(here, "..");
export const examplePath = join(docsRoot, "example", "home-example.mx");
export const markersPath = join(
  docsRoot,
  "example",
  "home-example.markers.json",
);
export const indexPath = join(docsRoot, "docs", "index.md");
/** docmd's output directory — the only place a heading slug is knowable. */
export const siteRoot = join(docsRoot, "site");

export const START = "<!-- mx-home:generated:start -->";
export const END = "<!-- mx-home:generated:end -->";

/**
 * A marked region: 1-based `line`, 0-based half-open `[from, to)` columns,
 * in the example's own text.
 */
export interface MarkerRange {
  line: number;
  from: number;
  to: number;
}

export interface Marker {
  id: string;
  label: string;
  note: string;
  href: string;
  /** The text the ranges must still cover — the drift guard. */
  match: string;
  ranges: MarkerRange[];
  /**
   * Strings that must appear inside the marked text.
   *
   * A range that silently stops short of the construct its label and note
   * name is invisible to every other check: the matched text still equals
   * `match`, the page still builds, and the only reader who notices is a human
   * diffing the note against the ranges — which is exactly how the `if-chain`
   * marker shipped twice claiming to cover an `<else>` it stopped short of.
   * Naming the constructs closes that gap: the build fails instead.
   */
  covers?: string[];
  /**
   * The node assertion: the type of the smallest named syntax node that
   * contains the whole marked region, in the tree-sitter MX grammar.
   *
   * A marker's line/column ranges are sub-node on purpose (a marker may cover
   * `class="row"` inside an element), so ranges cannot be node ranges. They
   * are tied to the tree instead: when an edit moves a range onto a different
   * construct, the enclosing node changes type and the build fails. See
   * `validateNodes`.
   */
  node: string;
  /** The region is exactly that node: same start, same end. */
  exact?: boolean;
  /** The smallest named node containing the region's first character. */
  startsIn: string;
  /** The smallest named node containing the region's last character. */
  endsIn: string;
}

/**
 * Ink colors, cycled across the markers in document order. The set is the
 * marko-ui hero's (`~/work/marko-ui/apps/docs/src/tags/home/home-hero.marko`,
 * commit f62ac76a) plus two docmd-token-adjacent hues; each is checked for
 * contrast against both `--bg-color` values before it is used here.
 */
const MARKER_COLORS = [
  "#ff5467",
  "#ffd100",
  "#7ced64",
  "#38bdf8",
  "#a78bfa",
  "#fb923c",
];

export function readExample(): { source: string; lines: string[] } {
  const source = readFileSync(examplePath, "utf8");
  return { source, lines: source.split("\n") };
}

export function readMarkers(): Marker[] {
  try {
    return JSON.parse(readFileSync(markersPath, "utf8")) as Marker[];
  } catch (error) {
    throw new Error(`${markersPath} is not readable JSON: ${String(error)}`);
  }
}

/** The text a range covers, joined the way a multi-line marker reads. */
export function textOf(lines: string[], range: MarkerRange): string {
  return (lines[range.line - 1] ?? "").slice(range.from, range.to);
}

/** The whole marked region of one marker, newlines included. */
export function matchedText(lines: string[], marker: Marker): string {
  return marker.ranges.map((range) => textOf(lines, range)).join("\n");
}

/** The docs page a marker link names, or `null` when it names no page. */
export function linkPage(href: string): string | null {
  const page = href.split("#")[0]?.split("?")[0] ?? "";
  return page || null;
}

/** Whether `href`'s page exists under `apps/docs/docs`. */
export function linkExists(href: string): boolean {
  const page = linkPage(href);
  if (!page) return false;
  const relative = page.replace(/^\/+|\/+$/g, "");
  const base = join(docsRoot, "docs", relative);
  return (
    existsSync(`${base}.md`) ||
    existsSync(join(base, "index.md")) ||
    existsSync(join(base, "README.md"))
  );
}

/**
 * Whether `href`'s fragment is an `id` the built site actually has.
 *
 * docmd's heading slugs are prefixed with the page title (and, on
 * `specification.md`, with the whole heading path), so no slug can be
 * predicted from the markdown by hand — fifteen of the links here were wrong
 * once. Only the built HTML knows the answer, so this reads
 * `site/<page>/index.html`; `--check` runs after `docmd build` for that
 * reason.
 */
export function anchorExists(href: string, siteDir = siteRoot): boolean {
  const [, fragment = ""] = href.split("#");
  if (!fragment) return true;
  const page = linkPage(href);
  if (!page) return false;
  const file = join(siteDir, page.replace(/^\/+|\/+$/g, ""), "index.html");
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf8").includes(`id="${fragment}"`);
}

/** Every marker key this file understands; anything else is a typo. */
const MARKER_KEYS = new Set([
  "id",
  "label",
  "note",
  "href",
  "match",
  "ranges",
  "covers",
  "node",
  "exact",
  "startsIn",
  "endsIn",
]);

/**
 * Every reason the example and its markers would make the home page a lie.
 * An empty array is the only acceptable answer.
 */
export function validate(lines: string[], markers: Marker[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  /** `[line, from, to)` per line, so two markers cannot claim the same text. */
  const claimed = new Map<number, Array<[number, number, string]>>();

  for (const marker of markers) {
    for (const key of Object.keys(marker)) {
      if (!MARKER_KEYS.has(key)) {
        errors.push(`marker \`${marker.id}\` has an unknown key \`${key}\``);
      }
    }
    if (seen.has(marker.id))
      errors.push(`duplicate marker id \`${marker.id}\``);
    seen.add(marker.id);
    if (!marker.label) errors.push(`marker \`${marker.id}\` has no label`);
    if (!/^\/[a-z0-9-]+\//.test(marker.href)) {
      errors.push(
        `marker \`${marker.id}\` has no page-level href: ${marker.href}`,
      );
    }
    if (!linkExists(marker.href)) {
      errors.push(
        `marker \`${marker.id}\` links a page that does not exist: ${marker.href}`,
      );
    }
    if (!marker.ranges.length) {
      errors.push(`marker \`${marker.id}\` has no range`);
      continue;
    }
    for (const range of marker.ranges) {
      const line = lines[range.line - 1];
      if (line === undefined) {
        errors.push(
          `marker \`${marker.id}\` points past the end of the file (line ${range.line})`,
        );
        continue;
      }
      if (range.from < 0 || range.to > line.length || range.from >= range.to) {
        errors.push(
          `marker \`${marker.id}\` is out of bounds on line ${range.line}: [${range.from}, ${range.to}) of ${line.length}`,
        );
        continue;
      }
      for (const [from, to, owner] of claimed.get(range.line) ?? []) {
        if (range.from < to && from < range.to) {
          errors.push(
            `marker \`${marker.id}\` overlaps marker \`${owner}\` on line ${range.line}`,
          );
        }
      }
      const own = claimed.get(range.line) ?? [];
      own.push([range.from, range.to, marker.id]);
      claimed.set(range.line, own);
    }
    const matched = matchedText(lines, marker);
    if (matched !== marker.match) {
      errors.push(
        `marker \`${marker.id}\` no longer covers its text:\n  expected ${JSON.stringify(marker.match)}\n  found    ${JSON.stringify(matched)}`,
      );
    }
    for (const expected of marker.covers ?? []) {
      if (!matched.includes(expected)) {
        errors.push(
          `marker \`${marker.id}\` declares it covers ${JSON.stringify(expected)}, which is not inside its marked text`,
        );
      }
    }
  }
  return errors;
}

/**
 * Compile the example exactly the way `packages/targets/html/src/example.ts`
 * does: custom tags discovered from `tags/`, then `compileFile`. A warning is
 * as much a failure as an error — a silent drop is exactly the drift the
 * gate exists to catch.
 */
export function compileExample(): { code: string; warnings: MxWarning[] } {
  const { customTags } = scanCached(examplePath, {
    host: "html",
    targets: htmlTargets,
  });
  const warnings: MxWarning[] = [];
  const { code } = compileFile(examplePath, { customTags, warnings });
  return { code, warnings };
}

/** The offset of each line's first character in `source`. */
function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

/** A marker's whole region as offsets into the source: first start, last end. */
function regionOf(
  starts: number[],
  marker: Marker,
): { start: number; end: number } {
  const first = marker.ranges[0] as MarkerRange;
  const last = marker.ranges[marker.ranges.length - 1] as MarkerRange;
  return {
    start: (starts[first.line - 1] as number) + first.from,
    end: (starts[last.line - 1] as number) + last.to,
  };
}

/**
 * Check every marker against the syntax tree.
 *
 * `match` and `covers` prove the text is still the text; this proves the text
 * is still the *construct*: the smallest named node around the region, the
 * node at its first character and the node at its last must all be the types
 * the marker names, and `exact` regions must equal their node. A range that
 * drifts off its construct changes one of those types and fails the build.
 */
export function validateNodes(source: string, markers: Marker[]): string[] {
  const errors: string[] = [];
  const tree = parseMx(source);
  if (tree.rootNode.hasError) {
    errors.push(
      `the example has syntax errors in the tree-sitter grammar: ${tree.rootNode.toString().slice(0, 300)}`,
    );
  }
  const starts = lineStarts(source.split("\n"));
  for (const marker of markers) {
    if (!marker.node || !marker.startsIn || !marker.endsIn) {
      errors.push(
        `marker \`${marker.id}\` needs \`node\`, \`startsIn\` and \`endsIn\``,
      );
      continue;
    }
    const { start, end } = regionOf(starts, marker);
    const root = tree.rootNode;
    const around = root.namedDescendantForIndex(start, end);
    const checks: Array<[string, string | undefined, string]> = [
      ["node", marker.node, around?.type ?? "(none)"],
      [
        "startsIn",
        marker.startsIn,
        root.namedDescendantForIndex(start, start + 1)?.type ?? "(none)",
      ],
      [
        "endsIn",
        marker.endsIn,
        root.namedDescendantForIndex(end - 1, end)?.type ?? "(none)",
      ],
    ];
    for (const [key, expected, found] of checks) {
      if (expected !== found) {
        errors.push(
          `marker \`${marker.id}\` ${key} is \`${expected}\`, the tree has \`${found}\``,
        );
      }
    }
    const exact = around?.startIndex === start && around?.endIndex === end;
    if (Boolean(marker.exact) !== exact) {
      errors.push(
        marker.exact
          ? `marker \`${marker.id}\` is declared exact but does not equal its \`${around?.type}\` node`
          : `marker \`${marker.id}\` equals its \`${around?.type}\` node exactly; declare \`exact: true\``,
      );
    }
  }
  return errors;
}

/**
 * The example, highlighted at build time by the tree-sitter MX grammar — the
 * very `renderMx` an ordinary ```mx fence goes through, so the annotated
 * example and a plain block carry identical spans. Colours come from the
 * `ts-*` classes in `assets/css/home.css`, which resolve against
 * `html[data-theme]`: the theme switch needs no JavaScript and no second copy
 * of the block.
 *
 * The marked regions are wrapped by cutting the capture spans at every marker
 * boundary (`renderMx`'s `ownerAt`): a marker that ends inside a token splits
 * that token, and the wrappers stay well nested.
 */
export function highlightExample(source: string, markers: Marker[]): string {
  const text = source.replace(/\n$/, "");
  const starts = lineStarts(text.split("\n"));
  const owners: string[] = new Array(text.length).fill("");
  for (const marker of markers) {
    const open = markerOpen(marker.id);
    for (const range of marker.ranges) {
      const base = starts[range.line - 1] as number;
      for (let at = base + range.from; at < base + range.to; at++) {
        owners[at] = open;
      }
    }
  }
  return `<pre class="hljs mx-hl" tabindex="0"><code class="language-mx">${renderMx(text, (at: number) => owners[at] ?? "")}</code></pre>`;
}

function markerOpen(id: string): string {
  return `<span class="mk" data-mk="${escapeHtml(id)}" tabindex="0" role="button" aria-describedby="note-${escapeHtml(id)}">`;
}

/** The notes, as real HTML: readable with scripting off. */
export function notesHtml(markers: Marker[]): string {
  return markers
    .map((marker) => {
      const id = escapeHtml(marker.id);
      return [
        `<li class="mx-home-note" id="note-${id}" data-mk="${id}">`,
        `<span class="mx-home-note-label">${escapeHtml(marker.label)}</span>`,
        `<span class="mx-home-note-text">${escapeHtml(marker.note)}</span>`,
        `<a class="mx-home-note-link" href="${escapeHtml(marker.href)}">Read the docs &rarr;</a>`,
        `</li>`,
      ].join("");
    })
    .join("");
}

/**
 * The per-marker rules. One `--mx-marker` and one active state each, so the
 * hover/focus/pin states are one attribute (`data-active` on `.mx-home`) and
 * no `:has()` — the interaction degrades to "every note is visible" when the
 * script does not run.
 */
export function markerCss(markers: Marker[]): string {
  return markers
    .map((marker, index) => {
      const id = escapeHtml(marker.id);
      const color = MARKER_COLORS[index % MARKER_COLORS.length] as string;
      return [
        `.mx-home .mk[data-mk="${id}"],.mx-home .mx-home-note[data-mk="${id}"]{--mx-marker:${color}}`,
        `.mx-home[data-active="${id}"] .mk[data-mk="${id}"]::before{inset:0 -0.2em}`,
        `.mx-home[data-active="${id}"] .mx-home-note[data-mk="${id}"]{border-color:var(--mx-marker);background:color-mix(in oklab,var(--mx-marker) 10%,transparent)}`,
        `.mx-home[data-active="${id}"] .mx-home-note[data-mk="${id}"] .mx-home-note-label{background:var(--mx-marker);color:#0b0b0c}`,
      ].join("");
    })
    .join("");
}

/**
 * The whole generated block for the landing page. No blank lines: markdown-it
 * ends an HTML block at the first one, and this text is written into a
 * markdown file.
 */
export function exampleSection(source: string, markers: Marker[]): string {
  const code = highlightExample(source, markers);
  return [
    `<style id="mx-home-marker-styles">`,
    markerCss(markers),
    `</style>`,
    `<section class="mx-home-example" aria-labelledby="mx-home-example-title">`,
    `<h2 id="mx-home-example-title">Every construct MX ships, in one file</h2>`,
    `<p class="mx-home-hint">Hover or focus a marked region to light it up; click, or press Enter, to pin its note. This exact file compiles on the <a href="/targets/html/">html target</a> on every docs build.</p>`,
    `<div class="mx-home-grid">`,
    `<div class="mx-home-code" tabindex="0" role="group" aria-label="MX source example">`,
    code,
    `</div>`,
    `<ol class="mx-home-notes">`,
    notesHtml(markers),
    `</ol>`,
    `</div>`,
    `</section>`,
  ].join("");
}

/** Replace the generated block in `docs/index.md` between its two markers. */
export function spliceIndex(markdown: string, fragment: string): string {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `docs/index.md must keep ${START} … ${END} around the generated block`,
    );
  }
  return (
    markdown.slice(0, start + START.length) +
    `\n${fragment.replace(/\n\s*\n/g, "\n")}\n` +
    markdown.slice(end)
  );
}
