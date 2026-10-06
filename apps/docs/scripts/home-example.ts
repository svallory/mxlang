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
import { classesOf, escapeHtml, parseMx } from "@mxlang/tree-sitter-mx/docmd";

const here = dirname(fileURLToPath(import.meta.url));

/** `apps/docs` — the docmd project root. */
export const docsRoot = join(here, "..");
export const examplePath = join(docsRoot, "example", "home-example.mx");
export const markersPath = join(
  docsRoot,
  "example",
  "home-example.markers.json",
);
export const cardsPath = join(docsRoot, "example", "home-example.cards.json");
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
  /** The card (`home-example.cards.json`) this construct is listed under. */
  card: string;
  /** The chip's text: the construct as it is written in the example. */
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
 * A card beside the code: one thing MX does, said in a sentence, with a chip
 * for each marker it comes from. `group` is the heading the card sits under;
 * the first group in the file is laid out beside the code, the others under it.
 */
export interface Card {
  id: string;
  group: string;
  title: string;
  /** One sentence; `backticks` become `<code>`. */
  text: string;
  /**
   * What the card's lines replace, as the JSX a reader already knows. Shown
   * as a small labelled snippet; it is an illustration, not compiled.
   */
  jsx?: string;
}

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

export function readCards(): Card[] {
  try {
    return JSON.parse(readFileSync(cardsPath, "utf8")) as Card[];
  } catch (error) {
    throw new Error(`${cardsPath} is not readable JSON: ${String(error)}`);
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
  "card",
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

const CARD_KEYS = new Set(["id", "group", "title", "text", "jsx"]);

/**
 * Every reason the cards and the markers would disagree: a marker filed under
 * a card that does not exist, a card nothing in the example comes from, or a
 * card whose markers would leave its chips empty.
 */
export function validateCards(markers: Marker[], cards: Card[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const card of cards) {
    for (const key of Object.keys(card)) {
      if (!CARD_KEYS.has(key)) {
        errors.push(`card \`${card.id}\` has an unknown key \`${key}\``);
      }
    }
    if (!/^[a-z][a-z0-9-]*$/.test(card.id ?? "")) {
      errors.push(`card id \`${card.id}\` is not a lowercase slug`);
    }
    if (ids.has(card.id)) errors.push(`duplicate card id \`${card.id}\``);
    ids.add(card.id);
    if (!card.group || !card.title || !card.text) {
      errors.push(`card \`${card.id}\` needs a group, a title and a text`);
    }
    if (!markers.some((marker) => marker.card === card.id)) {
      errors.push(`card \`${card.id}\` has no marker in the example`);
    }
  }
  for (const marker of markers) {
    if (!ids.has(marker.card)) {
      errors.push(
        `marker \`${marker.id}\` names a card that does not exist: \`${marker.card}\``,
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
 * The example as one highlighted `<pre>`, a block per line.
 *
 * The spans are the tree-sitter MX grammar's captures (`classesOf`, what an
 * ordinary ```mx fence is rendered from), so the panel and a plain block carry
 * identical classes; colours come from the `ts-*` rules in
 * `assets/css/home.css`.
 *
 * Two things are added. Each marked region is wrapped in a `.mk` that names
 * its marker and its card, cut at every capture boundary so the markup stays
 * well nested. And each line is a `.mxo-l` that lists the cards with a marker
 * on it (`data-cards`): a card being pointed at tints its lines as a band,
 * the way the Mesh overview tints the sections of an entity file.
 */
export function highlightExample(source: string, markers: Marker[]): string {
  const text = source.replace(/\n$/, "");
  const lines = text.split("\n");
  const starts = lineStarts(lines);
  const classes = classesOf(text);
  const owners: Array<Marker | undefined> = new Array(text.length);
  const lineCards: string[][] = lines.map(() => []);
  for (const marker of markers) {
    for (const range of marker.ranges) {
      const base = starts[range.line - 1] as number;
      for (let at = base + range.from; at < base + range.to; at++) {
        owners[at] = marker;
      }
      const cards = lineCards[range.line - 1] as string[];
      if (!cards.includes(marker.card)) cards.push(marker.card);
    }
  }
  const code = lines
    .map((line, index) => {
      const from = starts[index] as number;
      const to = from + line.length;
      let html = "";
      let open: Marker | undefined;
      let at = from;
      while (at < to) {
        const owner = owners[at];
        const cls = classes[at] ?? null;
        let end = at + 1;
        while (
          end < to &&
          (classes[end] ?? null) === cls &&
          owners[end] === owner
        ) {
          end++;
        }
        if (owner !== open) {
          if (open) html += "</span>";
          if (owner) html += markerOpen(owner);
          open = owner;
        }
        const chunk = escapeHtml(text.slice(at, end));
        html += cls ? `<span class="${cls}">${chunk}</span>` : chunk;
        at = end;
      }
      if (open) html += "</span>";
      const cards = lineCards[index] as string[];
      const attr = cards.length
        ? ` data-cards="${escapeHtml(cards.join(" "))}"`
        : "";
      // The newline stays inside the line's block, so the text of the panel
      // is the text of the file (a copy, a screen reader) and an empty line
      // keeps its height.
      const newline = index < lines.length - 1 ? "\n" : "";
      return `<span class="mxo-l"${attr}>${html}${newline}</span>`;
    })
    .join("");
  return `<pre class="hljs mx-hl mxo-code" tabindex="0" aria-label="MX source example"><code class="language-mx">${code}</code></pre>`;
}

function markerOpen(marker: Marker): string {
  return `<span class="mk" data-mk="${escapeHtml(marker.id)}" data-card="${escapeHtml(marker.card)}">`;
}

/** Prose with `backticks`, as HTML. */
function inlineCode(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** The cards' groups, in the order they first appear. */
export function cardGroups(cards: Card[]): string[] {
  return [...new Set(cards.map((card) => card.group))];
}

/**
 * The cards, as real HTML: every sentence and every link is readable with
 * scripting off. A card is focusable, so the keyboard reaches the same state
 * the pointer does; each chip is a link to the docs for one construct, and
 * pointing at a chip lights that construct alone.
 */
export function cardsHtml(markers: Marker[], cards: Card[]): string {
  return cardGroups(cards)
    .map((group) => {
      const heading = `<p class="mxo-group" data-group="${escapeHtml(group)}">${escapeHtml(group)}</p>`;
      const boxes = cards
        .filter((card) => card.group === group)
        .map((card) => {
          const id = escapeHtml(card.id);
          const chips = markers
            .filter((marker) => marker.card === card.id)
            .map(
              (marker) =>
                `<a class="mxo-chip" data-mk="${escapeHtml(marker.id)}" href="${escapeHtml(marker.href)}" title="${escapeHtml(marker.note.replace(/`/g, ""))}"><code>${escapeHtml(marker.label)}</code></a>`,
            )
            .join(", ");
          return [
            `<article class="mxo-card" data-card="${id}" data-group="${escapeHtml(group)}" tabindex="0" aria-labelledby="mxo-card-${id}">`,
            `<h3 id="mxo-card-${id}">${escapeHtml(card.title)}</h3>`,
            `<p>${inlineCode(card.text)}</p>`,
            `<p class="mxo-from">from ${chips}</p>`,
            // Not a <pre>: the snippet is an aside, and a <pre> here would be
            // styled as a second code panel.
            card.jsx
              ? `<div class="mxo-snip" aria-label="The same in JSX"><span class="mxo-snip-label">in JSX</span><code>${escapeHtml(card.jsx)}</code></div>`
              : "",
            `</article>`,
          ].join("");
        })
        .join("");
      return heading + boxes;
    })
    .join("");
}

/**
 * The rules that depend on the data: which lines a card tints, which region a
 * chip lights, which card a region outlines, and where each card sits on the
 * wide layout's grid. Generated, so the lists cannot drift from the cards.
 *
 * Every state is plain CSS (`:hover`, `:focus-within`, `:has()`): the block
 * works with scripting off. The page's script only adds `.is-hot` to a card
 * that was clicked, or that is on top while a phone scrolls.
 */
export function overviewCss(markers: Marker[], cards: Card[]): string {
  const ROOT = ".mxo-grid";
  const ON = ":is(:hover,:focus-within,.is-hot)";
  const rules: string[] = [];
  for (const card of cards) {
    const id = escapeHtml(card.id);
    const active = `${ROOT}:has(.mxo-card[data-card="${id}"]${ON})`;
    rules.push(
      `${active} .mxo-l[data-cards~="${id}"]{background:var(--mxo-band);box-shadow:inset 3px 0 0 var(--mxo-accent)}`,
      `${active} .mk[data-card="${id}"]{background:var(--mxo-ink);box-shadow:0 0 0 2px var(--mxo-ink)}`,
      `${ROOT}:has(.mk[data-card="${id}"]:hover) .mxo-card[data-card="${id}"]{border-color:var(--mxo-accent);box-shadow:0 0 0 3px var(--mxo-ring)}`,
    );
  }
  for (const marker of markers) {
    const id = escapeHtml(marker.id);
    rules.push(
      `${ROOT}:has(.mxo-chip[data-mk="${id}"]:is(:hover,:focus-visible)) .mk:not([data-mk="${id}"]){background:none;box-shadow:none}`,
      `${ROOT}:has(.mk[data-mk="${id}"]:hover) .mk[data-mk="${id}"]{background:var(--mxo-ink);box-shadow:0 0 0 2px var(--mxo-ink)}`,
      `${ROOT}:has(.mk[data-mk="${id}"]:hover) .mxo-chip[data-mk="${id}"] code{border-color:var(--mxo-accent);color:var(--mxo-accent)}`,
    );
  }
  // The wide layout: every group beside the file, each card as tall as its
  // content. The first group takes a card per row; the others, shorter, sit
  // two to a row. A last flexible row takes whatever height of the file is
  // left over, so no card is stretched to fill it.
  const [beside, ...under] = cardGroups(cards);
  const wide: string[] = [];
  let row = 1;
  const place = (group: string, perRow: number) => {
    wide.push(
      `${ROOT}>.mxo-group[data-group="${escapeHtml(group)}"]{grid-column:3/5;grid-row:${row}}`,
    );
    row++;
    const own = cards.filter((card) => card.group === group);
    own.forEach((card, index) => {
      const column = perRow === 1 ? "3/5" : String(3 + (index % perRow));
      wide.push(
        `${ROOT}>.mxo-card[data-card="${escapeHtml(card.id)}"]{grid-column:${column};grid-row:${row + Math.floor(index / perRow)}}`,
      );
    });
    row += Math.ceil(own.length / perRow);
  };
  if (beside !== undefined) place(beside, 1);
  for (const group of under) place(group, 2);
  wide.push(
    `${ROOT}{grid-template-rows:repeat(${row - 1},auto) 1fr}`,
    `${ROOT}>.mxo-file{grid-column:1/3;grid-row:1/${row + 1}}`,
  );
  return `${rules.join("")}@media (min-width:1181px){${wide.join("")}}`;
}

/**
 * The whole generated block for the landing page. No blank lines: markdown-it
 * ends an HTML block at the first one, and this text is written into a
 * markdown file.
 *
 * The layout, the bands and the cards with their "from" chips follow the
 * overview on the Mesh home page.
 * Credit: Mesh (svallory/mesh), design by the Mesh docs design dev under the
 * Mesh lead, 2026-10-05.
 */
export function exampleSection(
  source: string,
  markers: Marker[],
  cards: Card[],
): string {
  return [
    `<style id="mx-home-overview-styles">`,
    overviewCss(markers, cards),
    `</style>`,
    `<section class="mxo" aria-labelledby="mx-home-example-title">`,
    `<h2 id="mx-home-example-title">One file, and what is in it</h2>`,
    `<p class="mx-home-hint">Point at a card, or tab to it, to see where it comes from in the file; point at the code to find its card. This exact file compiles on the <a href="/targets/html/">html target</a> on every docs build.</p>`,
    `<div class="mxo-grid">`,
    `<div class="mxo-file">`,
    `<p class="mxo-file-name">home-example.mx</p>`,
    highlightExample(source, markers),
    `</div>`,
    cardsHtml(markers, cards),
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
