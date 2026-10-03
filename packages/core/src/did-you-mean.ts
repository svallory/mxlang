/**
 * "Did you mean" for an unresolved tag name.
 *
 * Marko itself suggests the closest taglib tag by `fastest-levenshtein`
 * distance under 4 (`runtime-tags/src/translator/visitors/tag/custom-tag.ts`
 * `tagNotFoundError`), which is noisy: `<dvi>` gets `<bdi>` (two edits) and
 * `<Card>` gets `<mark>`. A hint that sends the author to the wrong tag is
 * worse than none, so MX suggests only when exactly one candidate is
 * unambiguously nearest, and counts a swapped pair of letters as one edit.
 */

/** The HTML elements an author can mistype (no SVG/MathML, no obsolete tags). */
const HTML_ELEMENTS = [
  "a",
  "abbr",
  "address",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "base",
  "bdi",
  "bdo",
  "blockquote",
  "body",
  "br",
  "button",
  "canvas",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "datalist",
  "dd",
  "del",
  "details",
  "dfn",
  "dialog",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "link",
  "main",
  "map",
  "mark",
  "menu",
  "meta",
  "meter",
  "nav",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "script",
  "search",
  "section",
  "select",
  "slot",
  "small",
  "source",
  "span",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "track",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
];

/** Optimal-string-alignment distance: insert, delete, substitute, swap adjacent. */
function distance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row: number[] = [i];
    for (let j = 1; j <= b.length; j++) row[j] = i === 0 ? j : 0;
    rows.push(row);
  }
  for (let i = 1; i <= a.length; i++) {
    const row = rows[i] as number[];
    const above = rows[i - 1] as number[];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (above[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (above[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(
          row[j] as number,
          ((rows[i - 2] as number[])[j - 2] as number) + 1,
        );
      }
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

/**
 * The one candidate nearest to `name`, or `undefined` when nothing is close
 * enough or two candidates tie. One edit always counts; two only for a name of
 * five or more characters, and a name under three never suggests (`<sp>` is
 * near half the alphabet). Compared case-insensitively, so `Bage` finds
 * `Badge`; a candidate equal to `name` is never a suggestion.
 */
export function nearestName(
  name: string,
  candidates: Iterable<string>,
): string | undefined {
  if (name.length < 3) return undefined;
  const limit = name.length >= 5 ? 2 : 1;
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = limit + 1;
  let tied = false;
  for (const candidate of new Set(candidates)) {
    if (candidate === name) continue;
    const d = distance(lower, candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
      tied = false;
    } else if (d === bestDistance && best !== undefined) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

/** The HTML element `name` is most likely a typo of, if unambiguous. */
export function nearestHtmlElement(name: string): string | undefined {
  return nearestName(name, HTML_ELEMENTS);
}
