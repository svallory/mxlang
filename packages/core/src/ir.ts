/**
 * MX's host-independent intermediate representation (decision 79).
 *
 * The core parses a Marko template, validates it against a host's
 * declarations, and resolves the structural subset into the tree defined
 * here. A **host** then walks this tree and emits: the vanilla host prints a
 * string builder, Astro prints ternaries and `.map`, Solid prints
 * `<Show>`/`<For>`. None of them looks at a Marko node.
 *
 * ## Why an IR is possible here and not in Marko
 *
 * The constructs with compile-time semantics are *closed* in MX 1: the
 * structural core (`<if>`, `<for>`, `<define>`, `<const>`, statement tags)
 * plus "component call", where every user tag lowers the same way and
 * stateful tags are host hooks rather than user taglib hooks. Marko's own
 * taglibs let any tag define its own `analyze`/`translate`, so no fixed node
 * set could describe a Marko program. Decision 79's consequence for MX 2:
 * user-level compile hooks would need an opaque node every host must handle,
 * so that door stays shut.
 *
 * ## Positions
 *
 * Every node carries `loc`, in the shape `TranslateError` reports (1-based
 * line, 0-based column). Marko's own nodes carry no numeric offsets at all,
 * only `loc.{line,column}`, so that is what the IR can carry — see
 * `fragment.ts` for the measured limits.
 *
 * ## Expressions
 *
 * An expression appears as `Expr`: its source text, parsed shape, and the
 * Marko/Babel node it came from. The lowerer computes the shape once so an
 * emitter never has to inspect that parser node to distinguish an object,
 * array, string, or other expression. The text is what every host ultimately
 * emits: it is sliced from the authored source once during lower (printed
 * with Marko's own generator only for a node with no offsets), which keeps
 * hosts from each reaching for a Babel generator.
 *
 * The normative contract for every type here is
 * `apps/docs/docs/architecture/ir-spec.md`.
 */

import type { Node } from "./core.ts";
import type { DialectNode } from "./dialect-registry.ts";
import type { SourceSpan } from "./mapping.ts";
import type { TemplateMetadata } from "./template-tag.ts";

/**
 * The version of the IR's shape (decision 204). A consumer that reads the
 * IR itself (a dialect, through `lowerSource`) asserts it to detect a core
 * whose IR it was not written against. It goes up by one with every change
 * a reader could observe: a node kind or field added, removed, renamed or
 * given a new meaning. A host that only emits through `Emitter` need not read
 * it. `ir-entry/ir-version.test.ts` pins it with a hash of this file's type
 * declarations (and `Spanned`'s, `SourceSpan`'s and `TemplateMetadata`'s), so
 * a shape change fails until it goes up; a change of meaning alone is the
 * author's to catch. @unstable
 */
export const IR_VERSION = 6;

/** A source position, as Marko reports one and `TranslateError` carries it. */
export interface Position {
  /** 1-based, as Marko and `TranslateError` both count lines. */
  line: number;
  /** 0-based, as Marko and `TranslateError` both count columns. */
  column: number;
  /**
   * The file this position is measured in, when that is **not** the file being
   * compiled.
   *
   * The third position rule (spec §2): material inlined from a tag template
   * (`tags/icon.mx`) keeps its own file's line and column, so a diagnostic
   * raised inside the template points into the template rather than at the
   * call that expanded it. Absent — the overwhelmingly common case — means the
   * position belongs to the file under compilation, so every position that
   * existed before templates is unchanged and no consumer has to ask.
   *
   * A consumer that can only report against one file (the TypeScript plugin's
   * virtual code, whose source *is* the caller) drops a foreign-file position
   * rather than reporting the caller's line numbers for someone else's text.
   */
  file?: string;
}

/**
 * An expression, as both the parsed node and its printed source.
 *
 * `code` is the authored source text, sliced rather than reprinted, and has
 * already been through the binding registry's reference rewriting (decision
 * 70's third hook), so a host emits it verbatim rather than re-deriving it.
 * `node` is the original, for a host that must inspect the shape —
 * `class={a: true}` versus `class=someCall()` is an `ObjectExpression` test,
 * not a string test. It is `null` on a synthesized `Expr` (a custom tag's
 * `ctx.build.expr`, a decision-116 dynamic target), whose `shape` is
 * `"other"` and which has no `span`.
 */
export interface Expr {
  code: string;
  shape: ExprShape;
  node: Node | null;
  /**
   * File-absolute UTF-16 code-unit offsets of this expression's authored
   * source text.
   * Absent when the expression has no authored source — a synthesized `Expr`
   * built with no backing node, or a fabricated literal default — rather
   * than a fabricated span pointing at unrelated text. When `file` is set,
   * these offsets are measured into *that* file (in principle: nothing in
   * `packages/core` sets `Expr.file` today, so no live construct exercises
   * this yet — see `file`'s own comment).
   *
   * A shorthand `id` or `class` value with a placeholder (`#a${x}`,
   * `.a${x}.b`) has the span of the authored word run after the sigil, and
   * its `code` is the template literal (or array) core built over it, so
   * `code` need not equal the source sliced by `span`; a static `.a.b` is
   * the same (its value is `"a b"`).
   *
   * `node`'s position objects are shared between a parent expression and the
   * child at its coincident boundary (both hold the same offset, which is
   * correct to read), never between sibling expressions — each sibling gets
   * its own distinct position objects.
   */
  span?: SourceSpan;
  /**
   * The file this expression's source text lives in, when it is not the file
   * being compiled — an expression inlined from a tag template.
   *
   * Unset anywhere in `packages/core` today: a tag unit (`template-tag.ts`)
   * compiles under its *own* `Ctx` (`tag.source`/`tag.filename`), so every
   * `Expr` inside it is already absolute against that file without needing
   * this field — only `Position.file` is ever forwarded (`call.loc.file`,
   * `template-tag.ts`/`custom-tags.ts`), and even that is read from a value
   * nothing in this package originates. The field is plumbing for a future
   * writer (e.g. a caller that inlines a template's body into its own tree),
   * not a currently-exercised contract.
   */
  file?: string;
  /**
   * Every dialect node inside this expression, in source order: a node an
   * expression row claimed (`:a` in `[:a, :b]`), or the node a value row
   * claimed when its type's `lower` built an expression (the entry then
   * spans the whole value). Absent when there are none. `code` holds each
   * node's forward printed (`ExprNode.code` says where); `node` holds the
   * forward itself.
   */
  nodes?: ExprNode[];
  /**
   * The text of `code` before a reads rewrite (`rewriteAccessorReads`) changed
   * it, set only when it did change it. `code` then no longer lines up with
   * `span`; a host that maps the expression uses this to map the unchanged
   * runs one to one (`mappedExpr`).
   */
  unrewrittenCode?: string;
  /**
   * The authored `{ … }` block of an attribute method shorthand
   * (`onClick() { … }`), whose `code` is the equivalent `function` expression
   * printed by the compiler. Absent for every other expression, an authored
   * `function` expression included. A host maps the printed body against it.
   */
  bodySpan?: SourceSpan;
  /**
   * The authored text of `bodySpan`, set with it. `code` may carry the body
   * reprinted (`{ go() }` as `{ go(); }`) or with reads rewritten, so a host
   * diffs this against the printed body (`mappedRewrite`) to map it token by
   * token.
   */
  bodySource?: string;
}

/**
 * A dialect node inside an expression (`Expr.nodes`): the node a registered
 * type claimed, and its forward, the expression it lowered to. MX has no
 * vocabulary of its own for what a node means: the forward is made of nodes
 * native to the expression language (Babel's), so every target, checker and
 * host reads it as plain code, while a contract or a data consumer reads the
 * node.
 * @unstable
 */
export interface ExprNode {
  /** The node's registry key (`dialect:Type`, `atom:Atom`). */
  type: `${string}:${string}`;
  /** The authored text the node was claimed from, file-absolute. */
  span: SourceSpan;
  /** The node as its type's `parse` built it, frozen. */
  node: DialectNode;
  /**
   * What the type's `lower` returned (`ctx.expression(forward)`): the very
   * node `Expr.node` holds in the node's place, marks and all.
   */
  forward: Node;
  /**
   * Where `forward` is printed in `Expr.unrewrittenCode ?? Expr.code`
   * (UTF-16 offsets into that string). Absent only when the expression was
   * reprinted rather than spliced (an expression with no authored position).
   */
  code?: { start: number; end: number };
}

/**
 * A member reference a layer-2 dialect produced (decision 182 addenda 4
 * and 5), for a value slot that names a member of the enclosing
 * declaration (Mesh's `&dueOn` after a kind). Its runtime value is the name
 * as a string literal on every target; the IR keeps it distinct so a
 * contract (`type: "member"`) or a data consumer can tell it from a string.
 * `span` covers the whole authored token, sigil included.
 */
export interface Member {
  kind: "member";
  name: string;
  span: SourceSpan;
}

/**
 * `extra.mxMember` on a node a dialect built for a member reference
 * (decision 182 addendum 5): on the `StringLiteral` of a whole-value member
 * (core reads it into {@link Member}), and on whatever expression the module
 * hands `ctx.expression` inside an expression (`self.status` for Mesh's
 * `&status`). `name` is the member's name, `span` the authored token, sigil
 * included. Public API, as stable as the IR.
 *
 * Marks on a dialect's nodes (`extra.mxMember`, and a dialect's own
 * `extra.mxAtom`) reach every later reader unchanged: core never strips or
 * rewrites them. They stay for one alpha (0.1.0-alpha.33, the release
 * that adds `Expr.nodes`) and go in 0.1.0-alpha.34; a dialect reads its
 * nodes from `Expr.nodes`/`Attr.node` instead.
 */
export interface MxMemberMark {
  span: SourceSpan;
  name: string;
}

/** The syntax-level value shape known while resolving an expression. */
export type ExprShape = "object" | "array" | "string" | "other";

/** Common to every IR node. */
export interface IrBase {
  loc: Position;
}

/**
 * The sugar an attribute came from: the token the author wrote (`#main`,
 * `.big`, or a syntax module's trigger token) when the attribute was made from
 * it, so a diagnostic can say `.big` (`class`) and not only `class`. Absent on
 * an attribute written out.
 */
/**
 * The arguments an attribute was written with (`a(b, c)`), the same `Expr`s a
 * tag's `args` holds. Present only when the parentheses were written, so `a()`
 * carries `[]`. Not a method's parameters: `a(x) { … }` is a function value.
 */
export interface AttrArgs {
  args?: Expr[];
}

/**
 * File-absolute UTF-16 code-unit span of the whole attribute as authored: the
 * name through the value, its arguments, refinement or method body included
 * (`a=1`, `v:fn:=q`, `h(x) { … }`); a spread's `...` through its expression;
 * a shorthand's token (`#id`, `.big`). A default attribute (`<x="post">`)
 * starts at its `=`. `undefined` for an attribute synthesized with no source.
 *
 * An attribute the author did not write, one a contract `default` added to a
 * contract-only tag, has an empty `span` (and `nameSpan`, and value span) at
 * the end of the tag's name, in the IR `lowerSource` returns and in the
 * compile path alike. An authored attribute's `span` is never empty, so
 * `span.sourceStart === span.sourceEnd` marks the attribute as not written.
 *
 * It ends where the written value ends, wrapper included: the `)` of
 * `a=(x)`, the `T` of `a=x as T` (`AttrValueSpan.valueSpan` is that value).
 */
export interface AttrSpan {
  span?: SourceSpan;
}

/**
 * File-absolute UTF-16 code-unit span of a dynamic, bound, event or spread
 * attribute's value **as written**, wrapper included: the parentheses of
 * `(x)`, the `<T>` of a concise `<T>x`, the `!` of `x!`, the `as T` of
 * `x as T`, the `satisfies T` of `x satisfies T`, nested wrappers and the
 * comments between them (`((x as T)!)`). The default lowering strips those
 * wrappers, so `value` is the bare `x` and `value.span` covers only it; a
 * consumer that has to refuse a wrapped value (a reference that must be a
 * plain identifier) detects one by `valueSpan` differing from `value.span`.
 * A plain value has the two equal. The same convention as the static kind's
 * `valueSpan` (the literal, quotes included).
 *
 * For a spread it covers the expression after the `...`. For a method
 * attribute (`onLoad(e) { … }`) it is the method, which is `value.span`.
 * With `stripTypes: false` the wrapper stays in `value.node` and
 * `value.span` already covers the type assertion, so the two differ only by
 * the parentheses.
 *
 * Always present on a `SpannedIr` attribute (`lowerSource`): an attribute a
 * contract `default` added to a contract-only tag has an empty one at the end
 * of the tag's name, like its `span`. `undefined` only for an attribute built
 * with no source.
 */
export interface AttrValueSpan {
  valueSpan?: SourceSpan;
}

export interface AttrSugar {
  sugar?: string;
  /**
   * Set on the default attribute (`value`) a syntax module's trigger
   * produced: the token that set it, so a contract error says "`value` (set
   * by `…`)".
   */
  sugarValueOf?: string;
}

/**
 * One attribute on an element or a component call.
 *
 * `kind` separates the three shapes a host emits differently: a value known at
 * compile time (bakeable into a literal), one that is not, and a spread whose
 * keys are only known at run time.
 */
export type Attr =
  | ({
      kind: "static";
      name: string;
      value: string;
      /**
       * File-absolute UTF-16 code-unit span of the bare string literal, quotes included
       * (`"strng"` in `type="strng"`) — the same convention as `Expr.span` for
       * a string expression. For a default attribute (`<x="post">`) it is
       * `"post"`. `undefined` for an attribute synthesized with no source,
       * except one a contract `default` added to a contract-only tag: it has
       * a zero-width span at the end of the tag's name (see `span`).
       */
      valueSpan?: SourceSpan;
      /**
       * The attribute's authored name. A default attribute (`<x="post">`) has
       * no spelled name: its span is zero-width at the `=`, as in Marko
       * (htmljs-parser 5.18.0 `ensureAttrName`, index.js:574-580;
       * `@marko/language-tools` 2.7.0, index.js:3306-3310). Consumers detect
       * the empty range, like Marko. An empty `nameSpan` alone does not mean
       * a nameless default attribute: an attribute a contract `default` added
       * to a contract-only tag also has one (zero-width at the end of the
       * tag's name), so check `span` too (see `span`).
       */
      nameSpan: SourceSpan;
      /**
       * Set when the whole value is one member reference a dialect produced
       * (decision 182 addendum 5). `value` is the member's name, which is
       * what every target emits.
       */
      member?: Member;
      /**
       * Set when the whole value is one registered node (`mode=:strict`,
       * claimed by a value row, or placed by a trigger's
       * `ctx.attribute(name, node)`) whose type lowered it to this string,
       * or to a string literal. The node is as parsed, frozen, keyed
       * `dialect:Type`; `value` is the string every target emits. Never set
       * together with `member`.
       */
      node?: DialectNode;
    } & IrBase &
      AttrSpan &
      AttrSugar &
      AttrArgs)
  /** A bare attribute (`disabled`), HTML's spelling of `true`. */
  | ({ kind: "boolean"; name: string; nameSpan: SourceSpan } & IrBase &
      AttrSpan &
      AttrSugar &
      AttrArgs)
  | ({
      kind: "dynamic";
      name: string;
      value: Expr;
      nameSpan: SourceSpan;
    } & IrBase &
      AttrSpan &
      AttrValueSpan &
      AttrSugar &
      AttrArgs)
  /**
   * `value:=expr`, Marko's two-way binding. Resolved rather than rejected: a
   * host with no update path emits the initial value, which is what Marko's
   * own server render does.
   */
  | ({
      kind: "bound";
      name: string;
      value: Expr;
      /**
       * `fn` in `v:fn:=q`: Marko's refinement, a function the change handler
       * applies to the new value (`q = fn(next)`). An identifier `Expr` over
       * the modifier's text (`node: null`, `span` on the modifier). Absent
       * when the attribute has no modifier.
       */
      refinement?: Expr;
      nameSpan: SourceSpan;
    } & IrBase &
      AttrSpan &
      AttrValueSpan &
      AttrSugar &
      AttrArgs)
  /**
   * An event handler on an *element*: `onClick=fn` or `on-my-event=fn`.
   *
   * `event` is the resolved DOM event name — everything after `on`,
   * lowercased, for the `on<Name>` form; verbatim after `on-` for the
   * `on-<exact>` form — so a host emits its own spelling from one source of
   * truth rather than re-deriving it from `name`.
   *
   * A handler on a *component call* is never this kind: it stays an ordinary
   * `dynamic` prop, because a component's `onSelect` is its author's prop
   * contract, not a DOM event (the same reason `class` is not renamed on a
   * component call). The same holds for a `<define>` call, a custom tag, a
   * host tag (`<try onClick=fn>`) and an attribute tag — only a native
   * element lowers to this kind.
   */
  | ({
      kind: "event";
      /** The source spelling, for diagnostics: `onClick`, `on-my-event`. */
      name: string;
      /** The DOM event name: `click`, `my-event`. */
      event: string;
      value: Expr;
      nameSpan: SourceSpan;
    } & IrBase &
      AttrSpan &
      AttrValueSpan &
      AttrSugar &
      AttrArgs)
  | ({ kind: "spread"; value: Expr } & IrBase & AttrSpan & AttrValueSpan);

/**
 * A block of children a host emits as a callable unit: an attribute tag's
 * body, or a component's ordinary children.
 *
 * `params` are the tag params the block declares (`<@footer|year|>`), as
 * source text. A host that has no render-prop form rejects a non-empty
 * `params` itself — the core resolves the shape rather than deciding whether
 * the target can express it.
 */
export interface Block extends IrBase {
  /** Distinguishes `<Tag||>` from a tag with no parameter pipes. */
  hasParams: boolean;
  params: string[];
  children: IrNode[];
}

/** What a `<for>` iterates, normalized to the three forms a host emits. */
export type ForSource =
  | { kind: "of"; list: Expr }
  | { kind: "in"; object: Expr }
  /**
   * `from`/`to`/`until`. `inclusive` distinguishes `to=` (`<=`) from `until=`
   * (`<`); `from` is `null` when the author omitted it, and the host starts
   * at 0 — the lowerer does not invent a literal the author never wrote.
   * `step` is the increment per iteration; absent when the author omitted it,
   * and the host decides the default (1 for HTML's runtime loop, a `step`
   * prop for Solid's `<Repeat>`).
   */
  | {
      kind: "range";
      from: Expr | null;
      bound: Expr;
      inclusive: boolean;
      step: Expr | null;
    };

/** One branch of an if-chain: a condition and its children. */
export interface Branch extends IrBase {
  /** `null` for the trailing `<else>`. */
  condition: Expr | null;
  children: IrNode[];
  /**
   * File-absolute UTF-16 code-unit span of this branch's own tag — opening
   * tag, body and closing tag included; `undefined` for a synthesized branch.
   */
  span?: SourceSpan;
}

/**
 * A tag the core does not own, handed to the host with its parts resolved.
 *
 * The escape hatch decision 79 keeps deliberately narrow: the *core's*
 * structural tags are real IR kinds, and everything a host defines for itself
 * (`<try>`, `<html-comment>`, a `server` block, a future `<signal>`) arrives
 * here with its name, attributes, children and attribute tags already
 * resolved, so the host emits rather than re-parses. The Marko node itself is
 * not carried: a host that needs a field the IR does not model records it in
 * `data` from `resolveDelegatedTag`, while the node is still in hand.
 */
/**
 * How a wildcard child was written (decision 147). The tag's `name` is the
 * canonical tag whose contract it matched (the authored name itself for an
 * inline contract); this records the spelling the author wrote. Present only
 * when a parent's `children["*"]` entry matched.
 */
export interface TagAlias {
  /** The tag name as written (`title` in `<title>`). */
  authored: string;
  /** File-absolute UTF-16 code-unit span of the authored name. */
  span?: SourceSpan;
  /** The entry pattern's named capture groups; empty without any. */
  groups: Record<string, string>;
}

/**
 * Where a hook-synthesized tag came from: the layer-2 trigger a syntax
 * module's `lowerTrigger` turned into a child tag (`ctx.child`). The same
 * facts `extra.mxTrigger` carries on an expression stand-in, so a consumer
 * can tell `&title` from an authored `<member name="title"/>` without
 * comparing spans. Absent on every authored tag. Core names no trigger.
 */
export interface TagTrigger {
  /** The trigger row's `id` in the syntax table. */
  id: string;
  /** File-absolute UTF-16 code-unit span of the trigger's authored text. */
  span: SourceSpan;
  /** The authored text (`&title`). */
  text: string;
}

export interface DelegatedTag<Data = unknown> extends IrBase {
  name: string;
  /**
   * The absolute path of the dialect tag file that defines this tag (a file
   * in its dialect's `tagDirs`, read by `Dialect.tagFile`), so the dialect's
   * back end can find the definition. Absent on every other tag. @unstable
   */
  definedIn?: string;
  /** Set only on a tag a dialect's `lowerTrigger` built with `ctx.child`. */
  trigger?: TagTrigger;
  /** The authored spelling, when a wildcard child resolved to `name` (decision 147). */
  alias?: TagAlias;
  /**
   * File-absolute UTF-16 code-unit span of the tag name (`x` in `<x>`). `undefined` for a
   * dynamic tag (`<${expr}>`) and for a synthesized tag with no source.
   */
  nameSpan?: SourceSpan;
  /**
   * File-absolute UTF-16 code-unit span of the whole tag: opening tag, body and closing
   * tag, or the self-closed tag. `undefined` for a synthesized tag.
   */
  span?: SourceSpan;
  attrs: Attr[];
  /** Tag arguments, retained for a claimed dynamic tag. */
  args?: Expr[];
  children: IrNode[];
  attributeTags: AttributeTag[];
  attributeTagTree: AttributeTagNode[];
  attrTagProps: AttrTagProp[];
  params: string[];
  /** The tag's `/var` binding, as source text, when it declares one. */
  var: string | null;
  /**
   * Whatever the host decided about this tag at *lower* time, from its
   * `resolveDelegatedTag` hook.
   *
   * The point of the slot is that a host records its decision once, while the
   * Marko node is still in hand, instead of re-deriving it at emit time — an
   * emitter that had to re-inspect `node` would be walking Marko nodes again,
   * which is the thing the IR exists to stop. `undefined` when the host
   * supplies no hook.
   *
   * This is also the seam decision 80's user-tag macros will need: a
   * user-defined tag that carries compile-time meaning has to hand its
   * resolved form to every host through exactly this channel, since the core
   * cannot know what the macro decided. The original Marko node is deliberately
   * absent: emission must consume the IR and `data`, never re-walk parser nodes.
   */
  data: Data;
}

/** `<@name>body</@name>` — a prop of the component call it sits inside. */
export interface AttributeTag extends IrBase {
  name: string;
  nameSpan: SourceSpan;
  /**
   * File-absolute UTF-16 code-unit span of the whole `<@y …>…</@y>`, body and
   * closing tag included; `undefined` for a synthesized tag.
   */
  span?: SourceSpan;
  attrs: Attr[];
  block: Block;
  hasBody: boolean;
  attributeTags: AttributeTag[];
  attributeTagTree: AttributeTagNode[];
  attrTagProps: AttrTagProp[];
}

export interface ForHead {
  source: ForSource;
  params: string[];
  paramNodes: Node[];
  bindings: string[];
  paramSpans?: Array<SourceSpan | undefined>;
  key: Expr | null;
}

export type AttributeTagNode =
  | ({ kind: "AttributeTag"; tag: AttributeTag } & IrBase)
  | ({
      kind: "AttributeTagIf";
      branches: Array<{
        test?: Expr;
        span: SourceSpan;
        nodes: AttributeTagNode[];
      }>;
      /**
       * File-absolute UTF-16 code-unit span of the chain: the `<if>`'s start
       * through the last branch's end, as `IfChain.span`.
       */
      span?: SourceSpan;
    } & IrBase)
  | ({
      kind: "AttributeTagFor";
      loop: ForHead;
      nodes: AttributeTagNode[];
      /** File-absolute UTF-16 code-unit span of the whole `<for>`. */
      span?: SourceSpan;
    } & IrBase);

export interface AttrTagProp {
  name: string;
  cardinality: "single" | "array";
  as: "data" | "renderable";
  source: AttributeTagNode[];
  /** Internal provenance retained when a custom-tag transform rebuilds it. */
  declared?: boolean;
}

/**
 * What a component call resolves its target to.
 *
 * A call's tag-name span is not repeated here: `Component.nameSpan`
 * (below) already carries it, computed from the same `node.name` this
 * target is resolved from — one span, not two copies that could drift.
 */
export type ComponentTarget =
  /** An `import` binding or a taglib/`tags/`-discovered tag, by name. */
  | {
      kind: "name";
      name: string;
      resolvedPath?: string;
      /**
       * The local identifier the emitter calls, when it differs from `name`.
       *
       * Set by `lowerTag` only for a tag whose host answered
       * `resolveDiscoveredTagModule`: the tag's written name (`fancy-btn`) is
       * not an identifier, so the module imports the template under a minted
       * one (`_fancyBtn`). `name` stays the authored spelling for diagnostics
       * and callee-Input lookup. Absent means "call `name` itself", which is
       * every other target.
       */
      binding?: string;
    }
  /** A `<define>` in scope, with the parameter names it declared. */
  | { kind: "define"; name: string; params: string[] }
  /**
   * `<${expr}/>`, resolved at run time by the host.
   *
   * `valueImportBinding` is set only when this target was synthesized by
   * decision 116's routing — a capitalized tag bound to a value import that
   * isn't a `.marko`/`.mx` default import — never for an author's own
   * `<${expr}/>`. It names the local binding so `readCalleeInput` can still
   * resolve the callee's declared `Input` for typed attribute-tag checking,
   * exactly as it does for `kind: "name"`, even though the tag now lowers
   * dynamically at runtime. An authored dynamic tag stays unresolved, since
   * its expression is not in general a single known binding.
   */
  | { kind: "dynamic"; expr: Expr; valueImportBinding?: string };

/** One name an authored `import` brings in (`Import.names`). */
export interface ImportName {
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
   * The name as written (UTF-16 offsets): the imported name for a named
   * specifier (`b` in `{ b as c }`, the quotes included for
   * `{ "a-b" as ab }`), the binding for a default (`Icon`) or namespace
   * (`ns` in `* as ns`) import. An inline `type` keyword is not part of it.
   */
  span: SourceSpan;
  /**
   * The alias (`c` in `{ b as c }`); present whenever an `as` clause is
   * written, even `{ a as a }`, never for `{ a }`.
   */
  localSpan?: SourceSpan;
  /** Present (`true`) only for an inline `{ type X }` specifier. */
  typeOnly?: true;
}

export type IrNode =
  /**
   * A literal run of text. `value` is Marko-normalized (newline-bearing
   * whitespace runs dropped, the rest collapsed) while `span` slices the
   * text exactly as authored — the two deliberately differ on e.g.
   * `<div>line one\n  line two</div>`.
   */
  | ({
      kind: "Text";
      value: string;
      /**
       * File-absolute UTF-16 code-unit span of the authored text.
       * `undefined` for a synthesized Text — the empty placeholder an inert
       * disposition or `<return>` leaves behind, or a builder-produced node.
       */
      span?: SourceSpan;
    } & IrBase)
  /** `${expr}` / `$!{expr}`; `escaped` is false for the raw form. */
  | ({
      kind: "Interpolation";
      expr: Expr;
      escaped: boolean;
      /**
       * File-absolute UTF-16 code-unit span of the whole `${…}` / `$!{…}`,
       * delimiters included. `expr.span` covers the expression only.
       */
      span?: SourceSpan;
    } & IrBase)
  | ({
      kind: "Element";
      name: string;
      /** Set only on a tag a dialect's `lowerTrigger` built with `ctx.child`. */
      trigger?: TagTrigger;
      /** File-absolute UTF-16 code-unit span of the tag name; `undefined` if synthesized. */
      nameSpan?: SourceSpan;
      /** File-absolute UTF-16 code-unit span of the whole tag, body and closing tag included. */
      span?: SourceSpan;
      attrs: Attr[];
      children: IrNode[];
      /** True for `<br>` and friends: no children, no closing tag. */
      void: boolean;
    } & IrBase)
  | ({
      kind: "Component";
      target: ComponentTarget;
      /** Set only on a tag a dialect's `lowerTrigger` built with `ctx.child`. */
      trigger?: TagTrigger;
      /**
       * The opening tag name. Null for a run-time dynamic target, and for a
       * routed discovered-tag call whose `TagCall` has no source (a
       * synthesized call). A discovered tag's call routed to its generated
       * binding (`template-tag.ts`) carries the authored name's span, though
       * not a `span` of the whole call.
       */
      nameSpan: SourceSpan | null;
      /** File-absolute UTF-16 code-unit span of the whole call, body and closing tag included. */
      span?: SourceSpan;
      attrs: Attr[];
      /** Ordinary children, or null when the call has no content. */
      content: Block | null;
      attributeTags: AttributeTag[];
      attributeTagTree: AttributeTagNode[];
      attrTagProps: AttrTagProp[];
      /** Tag arguments, `<Row(a, b)/>`, for a positional `<define>` call. */
      args: Expr[];
      /**
       * The `/var` binding this call declares, as source text.
       *
       * Only ever set on a call to a unit that declares `<return>` — the
       * core rejects `/var` on one that does not, so an emitter never has to
       * decide what an unbackable binding means. Null for every other call.
       */
      var?: string | null;
      /**
       * Each identifier `var` declares, with its authored span (empty without
       * `/var`). Filled by `lower.ts` `varBindingsOf` and carried through
       * `template-tag.ts`. Lets an emitter that lifts bindings into one scope
       * refuse a duplicate at the authored name. Optional: an emitter that
       * ignores it needs no change.
       */
      varBindings?: Array<{ name: string; span?: SourceSpan }>;
      /**
       * This call's target returns `{ value, output }` rather than output
       * alone (design §3.3).
       *
       * Resolved at lower time from the target unit's cached metadata,
       * because the shape is invisible at the call site and an emitter
       * cannot compile the callee to find out. It is set even when the call
       * declares no `/var`: the output still has to be unwrapped out of the
       * pair.
       */
      returnsValue?: boolean;
      /**
       * The tag name the author wrote, when it differs from `target`.
       *
       * A discovered template tag routes to a *generated* import binding
       * (`$mx_Counter1`), so a diagnostic about the call would otherwise
       * name a binding the author never typed. Only set where they differ.
       */
      authoredName?: string;
      /** The authored spelling, when a wildcard child resolved to this tag (decision 147). */
      alias?: TagAlias;
    } & IrBase)
  | ({
      kind: "IfChain";
      branches: Branch[];
      /**
       * File-absolute UTF-16 code-unit span of the whole chain: from the
       * `<if>`'s `<` through the last branch's closing tag, so layout
       * whitespace and comments between branches are inside it.
       */
      span?: SourceSpan;
    } & IrBase)
  | ({
      kind: "For";
      source: ForSource;
      /** The tag params, as source text; at least one, enforced at lower. */
      params: string[];
      /** Original parser nodes for the params, retained for source mapping. */
      paramNodes: Node[];
      /** Every name the params bind, for a host that tracks scopes. */
      bindings: string[];
      /**
       * File-absolute UTF-16 code-unit span of the whole tag — opening tag,
       * body and closing tag included.
       */
      span?: SourceSpan;
      /**
       * File-absolute UTF-16 code-unit spans of each param, same convention
       * as `Expr.span` — one per `params`/`paramNodes` entry, `undefined` for a
       * param whose node carries no `loc`.
       */
      paramSpans?: Array<SourceSpan | undefined>;
      /**
       * The `by=` expression, as resolved source. `null` when the author
       * omitted it. A string-emitting host ignores it (no reconciliation in a
       * one-shot render, decision 65); a reactive host emits it as the
       * `keyed` prop on `<For>`.
       */
      key: Expr | null;
      children: IrNode[];
    } & IrBase)
  | ({
      kind: "Define";
      name: string;
      /** File-absolute UTF-16 code-unit span of the `<define>`'s own name, e.g. `Row`. */
      nameSpan?: SourceSpan;
      /**
       * File-absolute UTF-16 code-unit span of the whole tag — opening tag,
       * body and closing tag included.
       */
      span?: SourceSpan;
      params: string[];
      /**
       * File-absolute UTF-16 code-unit spans of each param, same convention
       * as `Expr.span` — one per `params` entry, `undefined` for a param whose
       * node carries no `loc`.
       */
      paramSpans?: Array<SourceSpan | undefined>;
      /**
       * The tag's own attributes, resolved like a component call's: Marko
       * lowers `<define/D a=1 b="s"/>` to `const D = { a: 1, b: "s" }`, so
       * they are properties of the define's value (`${D.a}` reads `1`).
       * Evaluated where the `<define>` is written, outside the params' scope.
       * A `content` attribute never rides along with a body: core refuses it,
       * since the body is `content`.
       */
      attrs: Attr[];
      children: IrNode[];
    } & IrBase)
  | ({
      kind: "Const";
      name: string;
      init: Expr;
      /** File-absolute UTF-16 code-unit span of the whole `<const/…/>` tag. */
      span?: SourceSpan;
    } & IrBase)
  /** A `static` block, or a host statement block that hoists like one. */
  | ({
      kind: "Static";
      /** The module code; empty for `static {}`, which hoists nothing but is still a module statement. */
      code: string;
      end: Position;
      /**
       * File-absolute UTF-16 code-unit span of the authored statement,
       * `static` keyword included, trailing line terminator excluded.
       */
      span?: SourceSpan;
    } & IrBase)
  | ({
      kind: "Import";
      code: string;
      bindings: string[];
      /**
       * The statement's Babel `ImportDeclaration`, as the MX front end parsed
       * it (the `MxModuleStatement`'s payload, as written: a whole
       * `import type` and an inline `{ type X }` are still in it, though the
       * compile strips them from the payload before lowering): a consumer
       * reads the module specifier and each specifier (`imported`, `local`,
       * `importKind`) from it instead of parsing `code` again. Typed `Node`,
       * like `Expr.node`, because this `.d.ts` may not name Babel's types.
       * Absent for a synthesized import, which has no authored source (lowering
       * refuses an authored `import` that is not one ES import declaration).
       */
      declaration?: Node;
      /**
       * The module specifier, unquoted (`"./icon.mx"` for `from './icon.mx'`),
       * read from `declaration`. Absent for a synthesized import (its
       * specifier is `specifier`) and when no declaration was parsed.
       */
      from?: string;
      /**
       * The names the statement brings in, in the order written, read from
       * `declaration`; empty for a side-effect import (`import "./polyfill"`).
       * A consumer reads the import here without Babel. Present exactly when
       * `from` is.
       */
      names?: ImportName[];
      /** Present (`true`) only for a whole `import type … from …`. */
      typeOnly?: true;
      end: Position;
      /**
       * File-absolute UTF-16 code-unit span of the authored statement,
       * trailing line terminator excluded. `undefined` for a synthesized
       * (`synthesized: true`) import, which has no authored source.
       */
      span?: SourceSpan;
      /**
       * True when the compiler minted this import for a discovered template
       * tag, rather than the author writing it.
       *
       * The distinction is load-bearing exactly once, on Solid: a `.solid.mx`
       * MX region is an *expression* inside a TypeScript module, so it has no
       * module scope of its own. An author writing `import` inside a region
       * is still an error — they have a real module to put it in — but a
       * synthesized import has nowhere else to go, so the parser bridge
       * hoists it into the surrounding module. Every other host emits both
       * kinds identically and ignores this flag.
       */
      synthesized?: boolean;
      /**
       * The module specifier, as written in `code`, for a synthesized import.
       *
       * Carried structurally so a consumer never has to parse it back out of
       * the statement text. Set with `synthesized`, absent otherwise.
       */
      specifier?: string;
      /**
       * The template's resolved absolute path, for a synthesized import.
       *
       * This is what dedupe and authored-import reuse key on (decision 95
       * ruling 3: "reused by resolved path"). Two specifiers can spell one
       * file — `./tags/icon.mx` and `./tags/../tags/icon.mx` — and resolving
       * is what collapses them to one entry. Set with `synthesized`, absent
       * otherwise.
       */
      resolvedPath?: string;
    } & IrBase)
  /** Any other top-level `export`, hoisted verbatim to module scope. */
  | ({
      kind: "Export";
      code: string;
      end: Position;
      /**
       * File-absolute UTF-16 code-unit span of the authored statement,
       * trailing line terminator excluded.
       */
      span?: SourceSpan;
    } & IrBase)
  /** `export interface Input`, lifted so a host can place it. */
  | ({
      kind: "InputInterface";
      code: string;
      end: Position;
      /**
       * File-absolute UTF-16 code-unit span of the authored statement,
       * trailing line terminator excluded.
       */
      span?: SourceSpan;
    } & IrBase)
  /** A statement lifted by decision 70's `hoist` hook. */
  | ({ kind: "Hoisted"; code: string; end: Position } & IrBase)
  | ({ kind: "DelegatedTag"; tag: DelegatedTag<unknown> } & IrBase)
  /** `<!doctype html>`; `value` has its delimiters stripped by Marko. */
  | ({ kind: "DocumentType"; value: string } & IrBase)
  /**
   * A comment. `html` distinguishes `<!-- -->` from a `//` line comment —
   * Marko strips the delimiters, so only the source can tell them apart.
   */
  | ({
      kind: "Comment";
      value: string;
      html: boolean;
      /**
       * File-absolute UTF-16 code-unit span of the whole comment, delimiters
       * included (`<!-- … -->`, or the `//` line).
       */
      span?: SourceSpan;
    } & IrBase);

/** The resolved template: its module-level parts, and its body. */
export interface Ir {
  /** `import` statements, hoisted to module scope in source order. */
  imports: Array<Extract<IrNode, { kind: "Import" }>>;
  /** `static`/`server` block statements, hoisted to module scope. */
  hoisted: Array<Extract<IrNode, { kind: "Static" | "Export" }>>;
  /** The author's `export interface Input`, or null. */
  inputInterface: Extract<IrNode, { kind: "InputInterface" }> | null;
  /** Whether a host must synthesize its specialised AttrTag type import. */
  needsAttrTagImport: boolean;
  /** Statements lifted to the render function's head by the hoist hook. */
  prelude: Array<Extract<IrNode, { kind: "Hoisted" }>>;
  /** The template body. */
  body: IrNode[];
  /** Facts about this file consumed by discovered callers and host typing. */
  tagMetadata: TemplateMetadata;
  /**
   * The PascalCase name this module's default export is declared under.
   *
   * Derived from the file's basename (`icon.mx` -> `Icon`) and re-minted if it
   * collides with a binding the file already has, so it is always a valid,
   * free identifier. Every host that emits a module emits
   * `export default function <exportName>(…)` rather than an anonymous
   * function, which is what makes **a tag's self-recursion need no import**
   * (design invariant §7.5-7): a template that calls its own name resolves to
   * this declaration, in its own module scope.
   *
   * Computed at lower time rather than passed to each emitter, because the
   * collision check needs the file's bindings and those live on `Ctx`.
   *
   * **Absent when this compilation is not a module**: a `.solid.mx` region is
   * an expression spliced into someone else's module, so there is no
   * declaration to name. A host that emits a module sets `Ctx.emitsModule`
   * and can rely on this being present.
   */
  exportName?: string;
  /**
   * The `<return value=EXPR/>` this unit declares, or null.
   *
   * Present means the module's default export returns `{ value, output }`
   * rather than the output alone — the two shapes of design §3.3, chosen by
   * the **tag** and never by a call site. Because a tag unit compiles without
   * seeing any of its callers, that choice is enforced by construction
   * (invariant §7.5-5): the grammar validated at the tag's own compile
   * guarantees at most one `<return>`, unconditional, so the signature is a
   * single shape rather than `T | undefined` per path.
   *
   * Lifted out of `body` the way `inputInterface` is: it is a property of the
   * unit, not a node to render in document order.
   */
  returnValue?: Expr | null;
}
