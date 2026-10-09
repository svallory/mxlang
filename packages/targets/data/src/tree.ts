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
 * Every span is core's `SourceSpan`: a pair of UTF-16 code-unit offsets from
 * file start. `Text`, `Comment`, `Interpolation` and the structural nodes
 * carry the spans core adds at `feat(core): spans on Text, Comment and
 * structural IR nodes` (#234) — the "swap `start` for `span`" the 131
 * addendum's item 7 scheduled. A text node's `value` is Marko-normalized
 * while its `span` slices the text exactly as authored; the two deliberately
 * differ on collapsed whitespace.
 */

import type { Expression } from "@babel/types";
import type { SourceSpan } from "@mxlang/core";

/**
 * An expression, as Marko's Babel instance parsed it plus its source.
 *
 * `code` is the **printed** form (Marko's generator), not the authored text:
 * a method shorthand `value({ post }) { … }` prints as
 * `function ({ post }) { … }`. `span` slices the **authored** text out of the
 * file — consumers that need what the author wrote slice by `span`, always.
 * `node` belongs to Marko's own Babel instance; its offsets live at
 * `node.loc.{start,end}.index` (file-absolute, UTF-16). It is `null` when core
 * built the expression itself (`Expr.node` is `Node | null`); an authored
 * expression always has one.
 */
export interface DataExpr {
  code: string;
  shape: "object" | "array" | "string" | "other";
  /** Required here: a tree expression always has authored source. */
  span: SourceSpan;
  node: Expression | null;
}

export type DataAttr =
  /**
   * `type="string"`, `<x="post">`: a string literal.
   *
   * For a shorthand attribute — `#myid` and `.cls1.cls2`, written right after
   * the tag name — the `name` is synthesized from the shorthand token rather
   * than written: `nameSpan` covers the sigil and the token (`#myid`), and
   * `valueSpan` the class/id text itself, without the `#`/`.` sigil. The field
   * stays optional in the type so a tree never has to carry a non-finite
   * offset.
   */
  | {
      kind: "string";
      name: string;
      value: string;
      nameSpan?: SourceSpan;
      valueSpan: SourceSpan;
    }
  /**
   * An attribute whose entire value is one atom (decision 156 addendum 1,
   * item 10): `mode=:strict`, and the `name` the `:name` sugar sets
   * (`<string :title/>`, `<input:email>`). `name` is the attribute's name,
   * `value` the atom's name, `span` the atom (`:` included). `nameSpan` is the
   * sugar token for the sugar form. An atom nested in an expression is not
   * this kind: it stays a `StringLiteral` with `extra.mxAtom = { span }`
   * inside `DataExpr.node` (`MxAtomMark`, from `@mxlang/core`).
   */
  | {
      kind: "atom";
      name: string;
      value: string;
      nameSpan?: SourceSpan;
      span: SourceSpan;
    }
  /**
   * An attribute whose entire value is one member reference a layer-2 syntax
   * module produced (decision 182 addenda 4 and 5): Mesh's `&dueOn` after a
   * kind (`sort asc &dueOn`), a sibling of the atom variant. `name` is the
   * attribute name the module's trigger declares, `value` the member's name
   * without its sigil, `span` the authored token, sigil included. `nameSpan`
   * is absent: the name is not written. A member inside an expression is not
   * this kind: it is whatever node the module built in `DataExpr.node`,
   * marked `extra.mxMember = { span, name }` (`MxMemberMark`, from
   * `@mxlang/core`).
   */
  | {
      kind: "member";
      name: string;
      value: string;
      nameSpan?: SourceSpan;
      span: SourceSpan;
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
      /**
       * `fn` in `v:fn:=q`: Marko's refinement, the function its change handler
       * applies to the new value (`q = fn(next)`). Only on a bound attribute
       * with a modifier; `node` is `null`, `span` slices the modifier.
       */
      refinement?: DataExpr;
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
  /**
   * Set only when a parent's `children["*"]` entry claimed this tag (decision
   * 147): the canonical tag whose contract applied. `name` stays the authored
   * spelling (`title`), `contract` is `attribute` for a `contract: "attribute"`
   * entry, and for an inline contract it equals `name`. Absent on every other
   * tag.
   */
  contract?: string;
  /**
   * The matched pattern's named capture groups; present only on a wildcard
   * match whose pattern has at least one named group that participated.
   */
  groups?: Record<string, string>;
  /**
   * Set only on a tag a syntax module's `lowerTrigger` built with `ctx.child`
   * (a tagless-line trigger such as Mesh's `&title`): the trigger's `id` from
   * the syntax table, the source span of its authored text and that text.
   * Absent on every authored tag, so `&title` and an authored
   * `<member name="title"/>` are told apart by this field, not by span.
   */
  trigger?: { id: string; span: SourceSpan; text: string };
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
  // `value` is Marko-normalized; `span` slices the text as authored.
  | { kind: "text"; value: string; span: SourceSpan }
  /**
   * `${x}` / `$!{x}`; `escaped` is false for the raw form. `span` covers the
   * whole `${…}`, delimiters included; `value.span` the expression only.
   */
  | { kind: "expression"; value: DataExpr; escaped: boolean; span: SourceSpan }
  /** `html` distinguishes `<!-- -->` from a `//` line comment. */
  | { kind: "comment"; value: string; html: boolean; span: SourceSpan }
  | { kind: "if"; branches: DataBranch<DataNode>[]; span: SourceSpan }
  | { kind: "for"; head: DataForHead; children: DataNode[]; span: SourceSpan }
  | { kind: "const"; name: string; init: DataExpr; span: SourceSpan };

export interface DataBranch<N> {
  /** `null` for the trailing `<else>`. */
  test: DataExpr | null;
  children: N[];
  /** The branch's own tag: opening tag, body and closing tag included. */
  span: SourceSpan;
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
 * authored. `span` slices the authored statement (the trailing line
 * terminator excluded) — for `export interface Input`, the one statement
 * kind core carries no span on, it is derived from the statement's positions
 * through the source's line table. Core splits statements out of the body
 * and loses their order relative to one another, so a document's
 * `statements` are sorted by `span`.
 */
export interface DataStatement {
  kind: "import" | "export" | "static";
  code: string;
  span: SourceSpan;
}

/** One name an `import` brings in. */
export interface DataImportName {
  /**
   * The name the module exports: `useState` for both `{ useState }` and
   * `{ useState as us }`, `"default"` for a default import, `"*"` for a
   * namespace import (every export is reachable through `local`).
   */
  imported: string;
  /** The binding this file refers to it by (the alias, when there is one). */
  local: string;
  kind: "default" | "named" | "namespace";
  /**
   * The name as written, in the source (UTF-16 offsets): the imported name for
   * a named specifier (`b` in `{ b as c }`, the quotes included for
   * `{ "a-b" as ab }`), the binding for a default (`Icon`) or namespace
   * (`ns` in `* as ns`) import, which write no separate exported name. An
   * inline `type` keyword is not part of it.
   */
  span: SourceSpan;
  /** The alias (`c` in `{ b as c }`); present whenever an `as` clause is written, even `{ a as a }`, never for `{ a }`. */
  localSpan?: SourceSpan;
  /** Present (`true`) only for an inline `{ type X }` specifier. */
  typeOnly?: true;
}

/**
 * A top-level `import`: the authored statement (`code`, `span`) and what the
 * front end parsed out of it. `from` and `names` are read from the parsed
 * `ImportDeclaration`, not from the text, so a quote style, a line break or
 * a comment inside the statement changes nothing.
 */
export interface DataImport {
  code: string;
  span: SourceSpan;
  /** The module specifier, unquoted: `"./icon.mx"` for `from './icon.mx'`. */
  from: string;
  /**
   * The names in the order written; empty for a side-effect import
   * (`import "./polyfill"`). A mixed import lists the default first, then the
   * named ones, as written.
   */
  names: DataImportName[];
  /** Present (`true`) only for a whole `import type … from …`. */
  typeOnly?: true;
}

export interface DataDocument {
  kind: "document";
  filename: string;
  statements: DataStatement[];
  /**
   * Only with `structural: "reject"` and `imports: "pass"`: each top-level
   * `import`, verbatim, in file order (UTF-16 `span`, like every span). They
   * are not in `statements` then, where every other kind would have been
   * rejected.
   */
  imports?: DataImport[];
  children: DataNode[];
}

/**
 * `T` with every Babel `node` removed, recursively. `node` is the one field
 * of the tree that is not plain data (`DataExpr.node`, Marko's own Babel
 * instance); everything else — `code`, `shape`, every `span` — is kept.
 */
export type WithoutBabelNodes<T> = T extends readonly (infer U)[]
  ? readonly WithoutBabelNodes<U>[]
  : T extends object
    ? {
        [K in keyof T as K extends "node" ? never : K]: WithoutBabelNodes<T[K]>;
      }
    : T;

/**
 * The data tree as a `.mx` data file's compiled module exports it: a
 * `DataDocument` with the Babel `node` of every expression removed, leaving
 * `code` (printed), `shape` and `span` (UTF-16 offsets into the authored
 * source). It is plain JSON-compatible data, so the module needs no runtime
 * import: the compiled module is a literal (`as const`) assignable to this
 * type, and imports nothing itself. A consumer that needs the Babel nodes calls `parseData` instead.
 */
export type SerializedDataDocument = WithoutBabelNodes<DataDocument>;
