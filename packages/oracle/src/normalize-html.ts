import type { DefaultTreeAdapterMap } from "parse5";
import * as parse5 from "parse5";

type P5Node = DefaultTreeAdapterMap["childNode"];

/**
 * Semantic HTML equality for the `oracle:marko` parity check — compares two
 * real HTML strings by their parsed structure and *decoded* content, not by
 * string spelling. See fixtures/README.md's "Marko column semantics" for the
 * contract this exists under.
 *
 * Round 1 compared raw strings after a handful of regex-based spelling
 * normalizations (void self-closing, attribute quote style, `&#34;`). That
 * approach could not tell a real content difference from a spelling one —
 * e.g. it could not confirm whether Marko's unescaped `>` in text is a
 * genuine escaping gap or just a different (safe) escaping strategy, because
 * `&gt;` and `>` never compared equal as strings. Parsing both sides with
 * `parse5` and comparing decoded values answers that for real: a browser's
 * HTML parser (which `parse5` implements) decodes `&gt;`/`&#34;`/etc. and a
 * raw `>` identically, so if they decode to the same text/attribute value,
 * they render identically — not a difference worth reporting.
 *
 * What is compared, per node:
 * - Element tag name, attribute names in source order, and each attribute's
 *   *decoded* value.
 * - Text node content, decoded.
 * - Comment node content, decoded — comments are real content here (see the
 *   `comments` fixture), not stripped.
 * - `<!doctype>` is compared as its own document-mode fact when present at
 *   the top of the fragment (parse5's fragment parser does not itself see a
 *   leading doctype as document content, so it is checked textually before
 *   handing the rest to `parseFragment`).
 *
 * What is *not* compared: raw attribute quote character, raw entity
 * spelling (`&quot;` vs `&#34;` vs a literal safe character), void-element
 * self-closing spelling, whitespace runs between tags (collapsed before
 * parsing — neither renderer is expected to preserve template-source
 * indentation as inter-tag whitespace), or a Marko resume/hydration marker
 * (an `<!--M_$…-->` comment immediately followed by an inline `<script>`
 * that revives it — stripped before parsing; these are Marko hydration
 * plumbing, not template content, and `@mxlang/target-html` has no equivalent
 * to compare against).
 */
export interface HtmlEqualsOptions {
  /**
   * Compare each element's attributes as a *set* rather than in source order.
   *
   * Off by default, because attribute order is real output for a host that
   * builds its own HTML string: `oracle:marko` asserts that `@mxlang/target-html`
   * reproduces Marko's own `value`-before-`type` hoist on an `<input>`, which
   * a browser can observe.
   *
   * On for a host that does not control its serializer. `oracle:preact`
   * renders through `preact-render-to-string`, which emits props in its own
   * order — comparing positionally there would report a difference in
   * Preact's serializer as a difference in MX's lowering, which is the one
   * thing this comparison exists to tell apart.
   */
  attributeOrder?: "strict" | "ignore";
}

export function htmlEquals(
  a: string,
  b: string,
  options: HtmlEqualsOptions = {},
): boolean {
  const [doctypeA, restA] = splitDoctype(a);
  const [doctypeB, restB] = splitDoctype(b);
  if (doctypeA !== doctypeB) return false;

  const fragA = parse5.parseFragment(
    collapseInterTagWhitespace(stripMarkoResumeMarker(restA)),
  );
  const fragB = parse5.parseFragment(
    collapseInterTagWhitespace(stripMarkoResumeMarker(restB)),
  );
  return nodesEqual(
    fragA.childNodes,
    fragB.childNodes,
    options.attributeOrder === "ignore",
  );
}

/**
 * Removes a Marko resume/hydration marker: `<!--M_$<n> <ids>-->` followed
 * immediately by the inline `<script>` that revives it on the client. Marko
 * emits this even for a pure server `output: "html"` render with
 * `optimize: true` for some constructs (an `<input>`, a dynamic spread) —
 * see `marko-compile-stock.ts`'s own doc comment. The marker's exact id/script
 * body is randomly generated per compile, so it can never byte-match
 * anything on the `@mxlang/target-html` side; stripping it here is the harness
 * treating it as what it is (hydration plumbing), not silently hiding a
 * real content difference — everything preceding the marker is still
 * compared normally.
 */
function stripMarkoResumeMarker(html: string): string {
  return html.replace(/<!--M_\$\d+[^>]*--><script>.*?<\/script>\s*$/s, "");
}

/**
 * A normalized, diffable string for a single HTML input — not used for the
 * pass/fail verdict (that's `htmlEquals`, comparing two inputs directly) but
 * handy for printing what a renderer actually produced, whitespace-collapsed
 * and re-serialized through parse5 so quoting/void-spelling noise is gone.
 */
export function normalizeHtml(html: string): string {
  const [doctype, rest] = splitDoctype(html);
  const frag = parse5.parseFragment(
    collapseInterTagWhitespace(stripMarkoResumeMarker(rest)),
  );
  return (doctype ?? "") + parse5.serialize(frag);
}

function splitDoctype(html: string): [string | null, string] {
  const match = /^\s*(<!doctype\s+[^>]*>)/i.exec(html);
  if (!match) return [null, html];
  const doctype = match[1] as string;
  return [
    doctype.toLowerCase().replace(/\s+/g, " "),
    html.slice(match[0].length),
  ];
}

function collapseInterTagWhitespace(html: string): string {
  return html.replace(/>\s+</g, "><").trim();
}

interface NodeSig {
  kind: "element" | "text" | "comment";
  name?: string;
  attrs?: [string, string][];
  value?: string;
  children?: P5Node[];
}

function nodesEqual(
  a: readonly P5Node[],
  b: readonly P5Node[],
  looseAttrOrder = false,
): boolean {
  const sigA = a.map(nodeSignature).filter((s): s is NodeSig => s !== null);
  const sigB = b.map(nodeSignature).filter((s): s is NodeSig => s !== null);
  if (sigA.length !== sigB.length) return false;
  return sigA.every((nodeA, i) =>
    nodeEquals(nodeA, sigB[i] as NodeSig, looseAttrOrder),
  );
}

function nodeSignature(node: P5Node): NodeSig | null {
  if ("value" in node && node.nodeName === "#text") {
    return { kind: "text", value: node.value };
  }
  if ("data" in node && node.nodeName === "#comment") {
    return { kind: "comment", value: node.data };
  }
  if (!("tagName" in node)) return null;
  return {
    kind: "element",
    name: node.tagName,
    attrs: node.attrs.map(
      (attr) => [attr.name, attr.value] as [string, string],
    ),
    children: node.childNodes,
  };
}

function nodeEquals(a: NodeSig, b: NodeSig, looseAttrOrder = false): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "text" || a.kind === "comment") return a.value === b.value;
  if (a.name !== b.name) return false;
  const attrsA = a.attrs ?? [];
  const attrsB = b.attrs ?? [];
  if (attrsA.length !== attrsB.length) return false;
  const ordered = (pairs: [string, string][]): [string, string][] =>
    looseAttrOrder
      ? [...pairs].sort(([left], [right]) => left.localeCompare(right))
      : pairs;
  const sortedA = ordered(attrsA);
  const sortedB = ordered(attrsB);
  for (let i = 0; i < sortedA.length; i++) {
    const [nameA, valueA] = sortedA[i] as [string, string];
    const [nameB, valueB] = sortedB[i] as [string, string];
    if (nameA !== nameB || valueA !== valueB) return false;
  }
  return nodesEqual(a.children ?? [], b.children ?? [], looseAttrOrder);
}
