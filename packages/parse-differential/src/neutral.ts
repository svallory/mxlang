/**
 * The neutral form both trees are projected into (brief §1.2 D): node kind,
 * names, spans, raw text spans, expression source text, attribute order,
 * shorthand parts, statement kind, error code and range. One line per node,
 * indented by depth.
 *
 * Not projected: `MxText.value` and expression payloads (PR 3), the front
 * end's `MX_*` errors (PR 2b), and fields today's tree does not carry (the
 * open and close tag spans, `bodyMode`, `concise`, `selfClosed`).
 */

export type Span = readonly [number, number];

export interface NTag {
  readonly kind: "tag";
  readonly name: string;
  readonly span: Span;
  /** `var "x"`, `args "a, b"` … in this order: typeArgs, var, args, typeParams, params. */
  readonly head: readonly string[];
  /** Tag-position sugar, ids then classes then `:` in source order (today's tree cannot order across sigils). */
  readonly sugar: readonly string[];
  readonly attrs: readonly string[];
  readonly children: readonly NNode[];
}

export interface NLeaf {
  readonly kind:
    | "text"
    | "placeholder"
    | "scriptlet"
    | "comment"
    | "cdata"
    | "doctype"
    | "declaration"
    | "statement";
  readonly span: Span;
  readonly detail: string;
}

export type NNode = NTag | NLeaf;

export interface NDocument {
  readonly body: readonly NNode[];
  /** Every atom, `:name@[s,e)`, sorted by start. */
  readonly atoms: readonly string[];
  /** `CODE [s,e) "message"` for the template error, or the thrown error of today's path. */
  readonly error: string | null;
}

const r = (span: Span) => `[${span[0]},${span[1]})`;

export function print(document: NDocument): string[] {
  const out: string[] = [];
  const visit = (node: NNode, depth: number) => {
    const pad = "  ".repeat(depth);
    if (node.kind === "tag") {
      out.push(`${pad}tag ${node.name} ${r(node.span)}`);
      for (const line of [...node.head, ...node.sugar, ...node.attrs]) {
        out.push(`${pad}  · ${line}`);
      }
      for (const child of node.children) visit(child, depth + 1);
      return;
    }
    out.push(
      `${pad}${node.kind} ${r(node.span)}${node.detail ? ` ${node.detail}` : ""}`,
    );
  };
  for (const node of document.body) visit(node, 0);
  if (document.atoms.length) out.push(`atoms ${document.atoms.join(" ")}`);
  if (document.error) out.push(`error ${document.error}`);
  return out;
}

/**
 * Expression text as compared: the authored text without the whitespace and
 * comments at its two ends. An MX container holds what was written between
 * the delimiters (ast §4.1); today's tree holds Babel nodes, whose range
 * excludes both, so only the code between them is comparable.
 */
export const text = (source: string) => JSON.stringify(trimCode(source));

/**
 * Expression text with the span of the code it compares: `source` starts at
 * file offset `start`; the span covers `trimCode(source)` inside it.
 */
export function code(source: string, start: number): string {
  const trimmed = trimCode(source);
  const at = trimmed === "" ? start : start + source.indexOf(trimmed);
  return `${JSON.stringify(trimmed)}@[${at},${at + trimmed.length})`;
}

export function trimCode(source: string): string {
  let out = source;
  for (;;) {
    const before = out;
    out = out.trim();
    if (out.startsWith("//")) {
      const end = out.indexOf("\n");
      out = end < 0 ? "" : out.slice(end + 1);
    } else if (out.startsWith("/*")) {
      const end = out.indexOf("*/");
      out = end < 0 ? "" : out.slice(end + 2);
    }
    out = out.replace(/\/\*(?:(?!\*\/)[\s\S])*\*\/$/, "");
    out = out.replace(/(^|\n)[ \t]*\/\/[^\n]*$/, "$1");
    out = out.replace(/[ \t]+\/\/[^\n"'`]*$/, "");
    if (out === before) return out;
  }
}
