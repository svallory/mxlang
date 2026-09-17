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
 * emits, and printing it once during lower keeps hosts from each reaching
 * for a Babel generator.
 */

import type { Node } from "./core.ts";
import type { SourceSpan } from "./mapping.ts";
import type { TemplateMetadata } from "./template-tag.ts";

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
 * `code` has already been through the binding registry's reference rewriting
 * (decision 70's third hook), so a host emits it verbatim rather than
 * re-deriving it. `node` is the original, for a host that must inspect the
 * shape — `class={a: true}` versus `class=someCall()` is an
 * `ObjectExpression` test, not a string test.
 */
export interface Expr {
  code: string;
  shape: ExprShape;
  node: Node;
  /**
   * File-absolute byte offsets of this expression's authored source text.
   * Absent when the expression has no authored source — a synthesized `Expr`
   * built with no backing node, or a fabricated literal default — rather
   * than a fabricated span pointing at unrelated text. When `file` is set,
   * these offsets are measured into *that* file (in principle: nothing in
   * `packages/core` sets `Expr.file` today, so no live construct exercises
   * this yet — see `file`'s own comment).
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
}

/** The syntax-level value shape known while resolving an expression. */
export type ExprShape = "object" | "array" | "string" | "other";

/** Common to every IR node. */
export interface IrBase {
  loc: Position;
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
      nameSpan: SourceSpan;
    } & IrBase)
  /** A bare attribute (`disabled`), HTML's spelling of `true`. */
  | ({ kind: "boolean"; name: string; nameSpan: SourceSpan } & IrBase)
  | ({
      kind: "dynamic";
      name: string;
      value: Expr;
      nameSpan: SourceSpan;
    } & IrBase)
  /**
   * `value:=expr`, Marko's two-way binding. Resolved rather than rejected: a
   * host with no update path emits the initial value, which is what Marko's
   * own server render does.
   */
  | ({
      kind: "bound";
      name: string;
      value: Expr;
      nameSpan: SourceSpan;
    } & IrBase)
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
    } & IrBase)
  | ({ kind: "spread"; value: Expr } & IrBase);

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
   * (`<`); `from` defaults to a literal `0` when the author omitted it.
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
}

/**
 * A tag the core does not own, handed to the host with its parts resolved.
 *
 * The escape hatch decision 79 keeps deliberately narrow: the *core's*
 * structural tags are real IR kinds, and everything a host defines for itself
 * (`<try>`, `<html-comment>`, a `server` block, a future `<signal>`) arrives
 * here with its name, attributes, children and attribute tags already
 * resolved, so the host emits rather than re-parses. `node` is the original
 * Marko node, for a host that needs a field the IR does not model.
 */
export interface HostTag<Data = unknown> extends IrBase {
  name: string;
  attrs: Attr[];
  children: IrNode[];
  attributeTags: AttributeTag[];
  params: string[];
  /** The tag's `/var` binding, as source text, when it declares one. */
  var: string | null;
  /**
   * Whatever the host decided about this tag at *lower* time, from its
   * `resolveHostTag` hook.
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
  block: Block;
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
  | { kind: "name"; name: string }
  /** A `<define>` in scope, with the parameter names it declared. */
  | { kind: "define"; name: string; params: string[] }
  /** `<${expr}/>`, resolved at run time by the host. */
  | { kind: "dynamic"; expr: Expr };

export type IrNode =
  /** A literal run of text. Already normalized by Marko's own `onText`. */
  | ({ kind: "Text"; value: string } & IrBase)
  /** `${expr}` / `$!{expr}`; `escaped` is false for the raw form. */
  | ({ kind: "Interpolation"; expr: Expr; escaped: boolean } & IrBase)
  | ({
      kind: "Element";
      name: string;
      attrs: Attr[];
      children: IrNode[];
      /** True for `<br>` and friends: no children, no closing tag. */
      void: boolean;
    } & IrBase)
  | ({
      kind: "Component";
      target: ComponentTarget;
      /** The opening tag name; null only for a run-time dynamic target. */
      nameSpan: SourceSpan | null;
      attrs: Attr[];
      /** Ordinary children, or null when the call has no content. */
      content: Block | null;
      attributeTags: AttributeTag[];
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
    } & IrBase)
  | ({ kind: "IfChain"; branches: Branch[] } & IrBase)
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
       * File-absolute byte spans of each param, same convention as
       * `Expr.span` — one per `params`/`paramNodes` entry, `undefined` for a
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
      /** File-absolute byte span of the `<define>`'s own name, e.g. `Row`. */
      nameSpan?: SourceSpan;
      params: string[];
      /**
       * File-absolute byte spans of each param, same convention as
       * `Expr.span` — one per `params` entry, `undefined` for a param whose
       * node carries no `loc`.
       */
      paramSpans?: Array<SourceSpan | undefined>;
      children: IrNode[];
    } & IrBase)
  | ({ kind: "Const"; name: string; init: Expr } & IrBase)
  /** A `static` block, or a host statement block that hoists like one. */
  | ({ kind: "Static"; code: string; end: Position } & IrBase)
  | ({
      kind: "Import";
      code: string;
      bindings: string[];
      end: Position;
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
  | ({ kind: "Export"; code: string; end: Position } & IrBase)
  /** `export interface Input`, lifted so a host can place it. */
  | ({ kind: "InputInterface"; code: string; end: Position } & IrBase)
  /** A statement lifted by decision 70's `hoist` hook. */
  | ({ kind: "Hoisted"; code: string; end: Position } & IrBase)
  | ({ kind: "HostTag"; tag: HostTag<unknown> } & IrBase)
  /** `<!doctype html>`; `value` has its delimiters stripped by Marko. */
  | ({ kind: "DocumentType"; value: string } & IrBase)
  /**
   * A comment. `html` distinguishes `<!-- -->` from a `//` line comment —
   * Marko strips the delimiters, so only the source can tell them apart.
   */
  | ({ kind: "Comment"; value: string; html: boolean } & IrBase);

/** The resolved template: its module-level parts, and its body. */
export interface Ir {
  /** `import` statements, hoisted to module scope in source order. */
  imports: Array<Extract<IrNode, { kind: "Import" }>>;
  /** `static`/`server` block statements, hoisted to module scope. */
  hoisted: Array<Extract<IrNode, { kind: "Static" | "Export" }>>;
  /** The author's `export interface Input`, or null. */
  inputInterface: Extract<IrNode, { kind: "InputInterface" }> | null;
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
