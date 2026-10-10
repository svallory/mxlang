/**
 * The view a host hook receives (ast §6.4; decisions 163 addendum 1 and
 * 197): plain data built by lowering from the MX AST, plus an opaque
 * `MxNodeHandle` that only core's helpers resolve. It replaces the
 * Marko-shaped view (`marko-view.ts`), so no `Mx*` node and no Marko shape
 * becomes public API of `@mxlang/core` through a host.
 *
 * Groundwork of PR 6 slice S4: built and pinned here; the hooks switch to it
 * in the slice itself.
 *
 * Rules, as for the Marko-shaped view: one view per node and `Ctx` (a hook
 * met twice in one compile sees the same object), every field computed on
 * first read, the view and its arrays frozen, nothing written back to the MX
 * tree. Positions are file-absolute UTF-16 offsets (`HostSpan`); a view has
 * a `span` and no `loc`, so `fail(message, view)` (and an attribute entry)
 * reports at `span.start`, the offset the Marko-shaped view's `loc.start`
 * held.
 *
 * Attribute entries are what lowering produced: the tag's attributes after
 * the name-sugar rewrite, so a merged `class` or a sugar's default value is
 * one entry, as a hook saw it on the Marko-shaped view.
 */
import { attrNameOf, attrValueOf } from "./attr-fields.ts";
import { bindingIdentifierNodes, type Ctx, type Node } from "./core.ts";
import { handleFor, handleNode, type MxNodeHandle } from "./host-handle.ts";
import type { Expr } from "./ir.ts";
import { exprOf, tagAttrNameSpan } from "./lower.ts";
import {
  tagAttributesOf,
  tagNameExprOf,
  tagNameOf,
  tagNameSpanOf,
  tagParamsOf,
  tagVarOf,
} from "./tag-fields.ts";

/** File-absolute UTF-16 code-unit offsets, `end` exclusive. */
export interface HostSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * An attribute as lowering produced it. The default value is named
 * `"value"`; `modifier` is what follows the last `:` (null without one).
 *
 * @unstable the host hook view; its shape may change before the hooks receive it.
 */
export interface HostAttributeView {
  readonly kind: "attribute";
  readonly name: string;
  readonly modifier: string | null;
  /**
   * The name's range, as lowering gives `Attr.nameSpan`: the head through
   * the modifier (`b:mod`), a shorthand's sigil and token (`.big`), a
   * sugar's token (`:email`); zero-width for a default value (ast §6.4, Q8).
   */
  readonly nameSpan: HostSpan;
  /**
   * The whole attribute: where an error about it is reported. A tag's own
   * shorthand (`<x.a#b>`'s `class`, its `id`) has no range of its own and
   * reports at its shorthand text, `nameSpan`.
   */
  readonly span: HostSpan;
  /** The value; absent for a valueless attribute. */
  readonly value?: Expr;
  readonly handle: MxNodeHandle;
}

/** @unstable the host hook view; its shape may change before the hooks receive it. */
export interface HostSpreadView {
  readonly kind: "spread";
  readonly span: HostSpan;
  readonly value: Expr;
  readonly handle: MxNodeHandle;
}

/**
 * A tag (or a module statement routed as one) as a hook sees it.
 *
 * @unstable the host hook view; its shape may change before the hooks receive it.
 */
export interface HostTagView {
  /** The tag name; an unnamed tag's resolved default name; for a module statement, its keyword. */
  readonly name: string;
  /**
   * The name's range: for `<${…}>`, the expression inside the braces; for a
   * name mixing text and `${…}` (`<foo-${bar}>`), the whole name; for an
   * unnamed tag, empty where a name would be written (after the `<`); for a
   * module statement, its keyword.
   */
  readonly nameSpan: HostSpan;
  /** The whole tag, or the statement's span. */
  readonly span: HostSpan;
  readonly attributes: readonly (HostAttributeView | HostSpreadView)[];
  /** The tag variable's pattern range, when written. */
  readonly var: { readonly span: HostSpan } | null;
  /**
   * The attribute tags as the Marko-shaped view listed them: each `@name`
   * child, and control flow (`<if>`, `<for>`, …) holding one, by its name.
   */
  readonly attributeTags: readonly {
    readonly name: string;
    readonly span: HostSpan;
  }[];
  /**
   * The body parameters, when pipes were written: `span` runs from the first
   * parameter's start to the last one's end, so the space inside the pipes
   * is not in it; an empty list (`||`) is empty after the opening pipe.
   */
  readonly params: { readonly span: HostSpan; readonly count: number } | null;
  /** The `<${…}>` name expression, else null (an atom name `<${:a}>` is static). */
  readonly dynamicName: Expr | null;
  readonly handle: MxNodeHandle;
}

/** Marko's control flow, which the Marko-shaped view listed as attribute tags when it held one. */
const CONTROL_FLOW = new Set(["if", "else-if", "else", "for", "while"]);

const views = new WeakMap<Ctx, WeakMap<object, object>>();

function cached<T extends object>(ctx: Ctx, node: Node, build: () => T): T {
  let perCtx = views.get(ctx);
  if (!perCtx) {
    perCtx = new WeakMap();
    views.set(ctx, perCtx);
  }
  const known = perCtx.get(node);
  if (known) return known as T;
  const view = build();
  perCtx.set(node, view);
  return view;
}

/** Defines `key` as an enumerable getter computed on first read. */
function lazy(view: object, key: string, compute: () => unknown): void {
  let done = false;
  let value: unknown;
  Object.defineProperty(view, key, {
    enumerable: true,
    get() {
      if (!done) {
        value = compute();
        done = true;
      }
      return value;
    },
  });
}

function spanOf(start: number, end: number): HostSpan {
  return Object.freeze({ start, end });
}

/** The offset of a 1-based line, 0-based column (a `loc` without `index`). */
function offsetAt(
  ctx: Ctx,
  at: { line: number; column: number; index?: number },
): number {
  if (typeof at.index === "number") return at.index;
  let offset = 0;
  for (let line = 1; line < at.line; line++) {
    offset += (ctx.lines[line - 1]?.length ?? 0) + 1;
  }
  return Math.min(ctx.source.length, offset + at.column);
}

/** `rangeOf`, else a Babel node's `loc` (a node built with lines and columns only). */
function locatedRangeOf(ctx: Ctx, node: Node): HostSpan | undefined {
  const range = rangeOf(node);
  if (range) return range;
  const loc = node?.loc;
  if (typeof loc?.start?.line !== "number") return undefined;
  return spanOf(offsetAt(ctx, loc.start), offsetAt(ctx, loc.end ?? loc.start));
}

/** The range of a node that has offsets (`start`/`end`), or of a field shape's `span`. */
function rangeOf(node: Node): HostSpan | undefined {
  if (typeof node?.start === "number" && typeof node?.end === "number") {
    return spanOf(node.start, node.end);
  }
  const span = node?.span;
  if (typeof span?.start === "number" && typeof span?.end === "number") {
    return spanOf(span.start, span.end);
  }
  return undefined;
}

/** The view of a tag (`MxTag`, `MxReturn`, `MxAttributeTag`, a module statement). */
export function hostTagViewOf(ctx: Ctx, node: Node): HostTagView {
  return cached(ctx, node, () => buildTagView(ctx, node));
}

function buildTagView(ctx: Ctx, node: Node): HostTagView {
  const view: Record<string, unknown> = {
    span: spanOf(node.start, node.end),
    handle: handleFor(node),
  };
  // An atom name (`<${:a}>`) is static, as on Marko's tree: `tagNameOf`
  // reads it, and answers nothing only for a name that is really dynamic.
  const dynamic =
    node.name?.kind === "dynamic" && tagNameOf(node) === undefined;
  // An unnamed tag's name changes once `resolveDefaultTag` answers, so it is
  // read on every access, not memoized.
  Object.defineProperty(view, "name", {
    enumerable: true,
    get: () => String(tagNameOf(node) ?? ""),
  });
  lazy(view, "nameSpan", () => {
    // A `<${…}>` name is its expression inside the braces, as on the
    // Marko-shaped view: a `${"a"}` string's range is its `loc`.
    // A name with text around its `${…}` has no such expression to give:
    // it falls through to the whole name.
    if (node.name?.kind === "dynamic") {
      const range = locatedRangeOf(ctx, tagNameExprOf(node));
      if (range) return range;
    }
    // A module statement's name is its keyword (`tagNameSpanOf`), a mixed
    // name its whole `MxExpression`. An unnamed tag's default is written
    // over an empty span where its name would be: the shorthand has no
    // authored name.
    const span = rangeOf(tagNameSpanOf(node)) ?? {
      start: node.start,
      end: node.start,
    };
    const end = node.name?.kind === "unnamed" ? span.start : span.end;
    return spanOf(span.start, end);
  });
  lazy(view, "attributes", () =>
    Object.freeze(
      tagAttributesOf(node).map((attr: Node) =>
        hostAttributeViewOf(ctx, attr, node),
      ),
    ),
  );
  lazy(view, "var", () => {
    const pattern = tagVarOf(node);
    const span = pattern ? rangeOf(pattern) : undefined;
    return span ? Object.freeze({ span }) : null;
  });
  lazy(view, "attributeTags", () =>
    Object.freeze(
      (node.body ?? []).filter(holdsAttributeTags).map((child: Node) =>
        Object.freeze({
          name: String(tagNameOf(child) ?? ""),
          span: spanOf(child.start, child.end),
        }),
      ),
    ),
  );
  lazy(view, "params", () => {
    if (!node.params) return null;
    const params = tagParamsOf(node);
    const first = params.length ? locatedRangeOf(ctx, params[0]) : undefined;
    const last = params.length ? locatedRangeOf(ctx, params.at(-1)) : undefined;
    const inside = rangeOf(node.params);
    const span =
      first && last
        ? spanOf(first.start, last.end)
        : inside && spanOf(inside.start, inside.start);
    return span ? Object.freeze({ span, count: params.length }) : null;
  });
  lazy(view, "dynamicName", () =>
    dynamic ? exprOf(ctx, tagNameExprOf(node)) : null,
  );
  return Object.freeze(view) as unknown as HostTagView;
}

/** An attribute tag, or control flow holding one. */
function holdsAttributeTags(child: Node): boolean {
  if (child?.type === "MxAttributeTag") return true;
  if (child?.type !== "MxTag" || child.name?.kind !== "static") return false;
  if (!CONTROL_FLOW.has(child.name.value)) return false;
  return (child.body ?? []).some(holdsAttributeTags);
}

/**
 * The entry of one attribute of `tag`: an `MxAttribute`/`MxSpreadAttribute`,
 * or a record the name-sugar rewrite built in their place. The tag is what
 * positions a shorthand's record, which has no range of its own.
 */
export function hostAttributeViewOf(
  ctx: Ctx,
  attr: Node,
  tag: Node,
): HostAttributeView | HostSpreadView {
  return cached(ctx, attr, () => buildAttributeView(ctx, attr, tag));
}

function buildAttributeView(
  ctx: Ctx,
  attr: Node,
  tag: Node,
): HostAttributeView | HostSpreadView {
  const named = (): HostSpan => {
    const span = tagAttrNameSpan(ctx, attr, tag);
    return spanOf(span.sourceStart, span.sourceEnd);
  };
  // A shorthand's record (`<x.a#b>`'s merged `class`, its `id`) carries no
  // range of its own, where the Marko-shaped view had no position to give:
  // it reports at its shorthand text, the name span lowering reads off the
  // tag (`.a.${x}` included), else at its value, else at the tag's name.
  const span = rangeOf(attr) ?? shorthandSpan(ctx, attr, tag, named());
  const view: Record<string, unknown> = { span, handle: handleFor(attr) };
  const spread =
    attr.type === "MxSpreadAttribute" || attr.type === "MarkoSpreadAttribute";
  if (spread) {
    view.kind = "spread";
    lazy(view, "value", () => exprOf(ctx, attrValueOf(ctx, attr)));
    return Object.freeze(view) as unknown as HostSpreadView;
  }
  view.kind = "attribute";
  view.name = attrNameOf(attr);
  view.modifier = attr.modifier ?? null;
  lazy(view, "nameSpan", named);
  // Valueless: no value on an `MxAttribute`; the synthesized, position-less
  // `true` a sugar record copies from `attrValueOf`.
  const value = attr.value;
  const valueless =
    value == null ||
    (value.type === "BooleanLiteral" &&
      value.value === true &&
      value.start == null &&
      value.loc == null);
  if (!valueless) {
    lazy(view, "value", () => exprOf(ctx, attrValueOf(ctx, attr)));
  }
  return Object.freeze(view) as unknown as HostAttributeView;
}

/** Where a record with no range of its own reports (`buildAttributeView`). */
function shorthandSpan(
  ctx: Ctx,
  attr: Node,
  tag: Node,
  named: HostSpan,
): HostSpan {
  if (named.end > named.start) return named;
  const value = locatedRangeOf(ctx, attr.value);
  if (value) return value;
  return hostTagViewOf(ctx, tag).nameSpan;
}

/**
 * The span of the binding identifier `name` declares inside `target`, the
 * first in source order: `target` is a view or handle (its tag variable) or
 * a binding pattern payload (a Babel pattern, as `checkBinding` receives).
 * `null` when the pattern binds no such name (ast §6.4).
 *
 * @unstable the host hook view; its shape may change before the hooks receive it.
 */
export function bindingSpan(
  target: MxNodeHandle | HostTagView | Node,
  name: string,
): HostSpan | null {
  const node = handleNode(target);
  const pattern = node !== undefined ? tagVarOf(node) : target;
  for (const identifier of bindingIdentifierNodes(pattern)) {
    if (identifier.name !== name) continue;
    const span = rangeOf(identifier);
    if (span) return span;
  }
  return null;
}
