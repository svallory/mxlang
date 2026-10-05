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
import { codeToTokens } from "shiki";

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
 * Every reason the example and its markers would make the home page a lie.
 * An empty array is the only acceptable answer.
 */
export function validate(lines: string[], markers: Marker[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  /** `[line, from, to)` per line, so two markers cannot claim the same text. */
  const claimed = new Map<number, Array<[number, number, string]>>();

  for (const marker of markers) {
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The example, highlighted at build time with Shiki's bundled Marko grammar
 * under the `mx` name.
 *
 * Two deliberate choices. `defaultColor: false` leaves every token carrying
 * `--shiki-light` and `--shiki-dark`, which `assets/css/home.css` resolves
 * against `html[data-theme]` — so the theme switch needs no JavaScript and no
 * second copy of the block. And the marked regions are wrapped here rather
 * than through Shiki's `decorations`, whose `end` position must land inside a
 * token: a marker that ends at a line's last character silently produced an
 * empty wrapper, which is the one bug a landing page cannot ship.
 */
export async function highlightExample(
  source: string,
  markers: Marker[],
): Promise<string> {
  const lines = source.split("\n");
  const { tokens } = await codeToTokens(source, {
    lang: "marko",
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });

  /** Which marker owns each column, per 0-based line index. */
  const owners = new Map<number, string[]>();
  for (const marker of markers) {
    for (const range of marker.ranges) {
      const index = range.line - 1;
      const owner =
        owners.get(index) ?? new Array(lines[index]?.length ?? 0).fill("");
      for (let column = range.from; column < range.to; column++) {
        owner[column] = marker.id;
      }
      owners.set(index, owner);
    }
  }

  let html = `<pre class="shiki" tabindex="0"><code>`;
  for (let line = 0; line < lines.length; line++) {
    html += `<span class="line">`;
    const owner = owners.get(line) ?? [];
    let column = 0;
    let open = "";
    for (const token of tokens[line] ?? []) {
      const style = styleOf(token);
      let start = 0;
      while (start < token.content.length) {
        const id = owner[column + start] ?? "";
        let end = start + 1;
        while (
          end < token.content.length &&
          (owner[column + end] ?? "") === id
        ) {
          end++;
        }
        if (id !== open) {
          if (open) html += `</span>`;
          if (id) html += markerOpen(id);
          open = id;
        }
        html += `<span style="${style}">${escapeHtml(token.content.slice(start, end))}</span>`;
        start = end;
      }
      column += token.content.length;
    }
    if (open) html += `</span>`;
    html += `</span>\n`;
  }
  return `${html}</code></pre>`;
}

function styleOf(token: { htmlStyle?: Record<string, string> }): string {
  return Object.entries(token.htmlStyle ?? {})
    .map(([property, value]) => `${property}:${value}`)
    .join(";");
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
export async function exampleSection(
  source: string,
  markers: Marker[],
): Promise<string> {
  const code = await highlightExample(source, markers);
  return [
    `<style id="mx-home-marker-styles">`,
    markerCss(markers),
    `</style>`,
    `<section class="mx-home-example" aria-labelledby="mx-home-example-title">`,
    `<h2 id="mx-home-example-title">Every construct MX ships, in one file</h2>`,
    `<p class="mx-home-hint">Hover or focus a marked region to light it up; click, or press Enter, to pin its note. This exact file compiles on the <a href="/hosts/html/">html target</a> on every docs build.</p>`,
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
