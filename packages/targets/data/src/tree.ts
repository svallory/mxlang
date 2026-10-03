/**
 * The data target's static tree (decisions 131/132 and the 131 addendum).
 *
 * A `.mx` file under the data target describes *what is written*, never what
 * it evaluates to: tags, attributes, attribute tags, text, `${}`
 * interpolations, the structural `<if>`/`<for>`/`<const>` nodes, comments and
 * the `import`/`export`/`static` statements. The tree is a closed,
 * serializable shape — deliberately smaller than core's IR, whose types it
 * does not reuse.
 *
 * Positions and spans share core's vocabulary: a `SourceSpan` is a pair of
 * UTF-16 code-unit offsets from file start, and a `DataPosition` is core's
 * `Position` (1-based line, 0-based column). `Text` and the structural nodes
 * carry only `start` until the core spans PR (the 131 addendum's item 7)
 * lands spans on `Text`, `Comment`, `Interpolation` and the structural IR
 * nodes; a later change of this package swaps `start` for `span`.
 */

import type { Expression } from "@babel/types";
import type { SourceSpan } from "@mxlang/core";

/** Line 1-based, column 0-based, like core's `Position`. */
export interface DataPosition {
  line: number;
  column: number;
}

/**
 * An expression, as Marko's Babel instance parsed it plus its source.
 *
 * `code` is the **printed** form (Marko's generator), not the authored text:
 * a method shorthand `value({ post }) { … }` prints as
 * `function ({ post }) { … }`. `span` slices the **authored** text out of the
 * file — consumers that need what the author wrote slice by `span`, always.
 * `node` belongs to Marko's own Babel instance; its offsets live at
 * `node.loc.{start,end}.index` (file-absolute, UTF-16).
 */
export interface DataExpr {
  code: string;
  shape: "object" | "array" | "string" | "other";
  /** Required here: a tree expression always has authored source. */
  span: SourceSpan;
  node: Expression;
}

export type DataAttr =
  /**
   * `type="string"`, `<x="post">`: a string literal.
   *
   * `nameSpan` is **absent** for a shorthand attribute — `#myid` and
   * `.cls1.cls2`, written right after the tag name — because core carries no
   * name span for one (its offsets arrive `NaN`; the core-side fix is TODO
   * `core-shorthand-attr-spans`) and the `name` is synthesized from the
   * shorthand token rather than written. `valueSpan` still slices what core
   * measured for it: the class/id text itself, without the `#`/`.` sigil.
   */
  | {
      kind: "string";
      name: string;
      value: string;
      nameSpan?: SourceSpan;
      valueSpan: SourceSpan;
    }
  /** `required`: a bare attribute. */
  | { kind: "boolean"; name: string; nameSpan: SourceSpan }
  /** `values=[...]`, `change=(x) => ...`, `n=1`, `v:=x` (bound). */
  | {
      kind: "expression";
      name: string;
      value: DataExpr;
      nameSpan: SourceSpan;
      bound?: true;
    }
  /** `...rest` */
  | { kind: "spread"; value: DataExpr };
// A default attribute (`<resource="post">`) arrives named `value` with a
// zero-width `nameSpan` at the `=` — the same convention as Marko.

export interface DataTag {
  kind: "tag";
  /**
   * The tag's name, as Marko parsed it. Deliberately **not** restricted to a
   * plain identifier: XML-style namespaced names (`svg:rect`, `soap:Envelope`)
   * and non-ASCII names are all legal and all pass through. The only names
   * refused are the ones that are not names at all — a leading `$` or `!`, or
   * a `{`/`}`/whitespace — because those are a concise `$!{x}` line or a
   * `$const x = 1` scriptlet that Marko parses as a tag (decision 54: MX has
   * no scriptlets). The same rule applies to `DataAttrTag.name`.
   */
  name: string;
  nameSpan: SourceSpan;
  /** The whole tag: opening tag, body and closing tag included. */
  span: SourceSpan;
  /**
   * Attributes in the order the IR hands them over: the **authored**
   * attributes first, in authored order, then any the shorthand `#id`/`.class`
   * synthesized, `class` before `id` (core's order — it merges the shorthand
   * classes into one `class` attribute and appends it). Shorthand is only
   * legal immediately after the tag name, so those two always come last.
   *
   * The one combination that cannot appear here is a shorthand class **and**
   * an authored `class` on the same tag (`<x.a class="b"/>`): core merges
   * them into one synthesized `class` expression with no span, so there is no
   * source range to carry and the target rejects the pair with one positioned
   * diagnostic. That lifts when TODO `core-shorthand-attr-spans` gives core a
   * real span for a merged attribute.
   */
  attrs: DataAttr[];
  /** Tag arguments: `<x(1, 2)>`. */
  args: DataExpr[];
  /** Tag params (`<x|a, b|>`), as source text. */
  params: string[];
  /** `<@y>` attribute tags, with `<if>`/`<for>` among them kept. */
  attrTags: DataAttrTagNode[];
  children: DataNode[];
}

export interface DataAttrTag {
  kind: "attr-tag";
  /**
   * Without the `@`. Subject to the same naming rule as `DataTag.name`: a
   * namespaced or non-ASCII name is fine, a `$…`/`!…`/placeholder name is
   * not.
   */
  name: string;
  nameSpan: SourceSpan;
  span: SourceSpan;
  attrs: DataAttr[];
  params: string[];
  attrTags: DataAttrTagNode[];
  children: DataNode[];
}

export type DataAttrTagNode =
  | DataAttrTag
  | { kind: "if"; branches: DataBranch<DataAttrTagNode>[] }
  | { kind: "for"; head: DataForHead; children: DataAttrTagNode[] };

export type DataNode =
  | DataTag
  // `start` stands in for `span` until the core spans PR lands (file header).
  | { kind: "text"; value: string; start: DataPosition }
  /** `${x}` / `$!{x}`; `escaped` is false for the raw form. */
  | { kind: "expression"; value: DataExpr; escaped: boolean }
  /** `html` distinguishes `<!-- -->` from a `//` line comment. */
  | { kind: "comment"; value: string; html: boolean; start: DataPosition }
  | { kind: "if"; branches: DataBranch<DataNode>[]; start: DataPosition }
  | {
      kind: "for";
      head: DataForHead;
      children: DataNode[];
      start: DataPosition;
    }
  | { kind: "const"; name: string; init: DataExpr; start: DataPosition };

export interface DataBranch<N> {
  /** `null` for the trailing `<else>`. */
  test: DataExpr | null;
  children: N[];
  start: DataPosition;
}

export interface DataForHead {
  source:
    | { kind: "of"; list: DataExpr }
    | { kind: "in"; object: DataExpr }
    | {
        kind: "range";
        from: DataExpr | null;
        bound: DataExpr;
        inclusive: boolean;
        step: DataExpr | null;
      };
  params: string[];
  paramSpans: (SourceSpan | undefined)[];
  key: DataExpr | null;
}

/**
 * `import`, `export`, `static`, `export interface Input`: the code text, as
 * authored. Core splits statements out of the body and loses their order
 * relative to one another, so a document's `statements` are sorted by `start`.
 */
export interface DataStatement {
  kind: "import" | "export" | "static";
  code: string;
  start: DataPosition;
  end: DataPosition;
}

export interface DataDocument {
  kind: "document";
  filename: string;
  statements: DataStatement[];
  children: DataNode[];
}
