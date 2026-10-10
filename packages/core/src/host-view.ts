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
import { exprOf } from "./lower.ts";
import {
  tagAttributesOf,
  tagNameExprOf,
  tagNameOf,
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
 * @unstable decision 197, PR 6.
 */
export interface HostAttributeView {
  readonly kind: "attribute";
  readonly name: string;
  readonly modifier: string | null;
  /** The name's range; zero-width for a default value (ast §6.4, Q8). */
  readonly nameSpan: HostSpan;
  /** The whole attribute: where an error about it is reported. */
  readonly span: HostSpan;
  /** The value; absent for a valueless attribute. */
  readonly value?: Expr;
  readonly handle: MxNodeHandle;
}

/** @unstable decision 197, PR 6. */
export interface HostSpreadView {
  readonly kind: "spread";
  readonly span: HostSpan;
  readonly value: Expr;
  readonly handle: MxNodeHandle;
}

/**
 * A tag (or a module statement routed as one) as a hook sees it.
 *
 * @unstable decision 197, PR 6.
 */
export interface HostTagView {
  /** The tag name; an unnamed tag's resolved default name; for a module statement, its keyword. */
  readonly name: string;
  /**
   * The name's range: for `<${…}>`, the expression inside the braces; for an
   * unnamed tag, empty where a name would be written (after the `<`).
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
  /** The body parameters, when pipes were written: first to last, pipes excluded. */
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
    if (node.name?.kind === "dynamic") {
      const range = locatedRangeOf(ctx, tagNameExprOf(node));
      if (range) return range;
    }
    // An unnamed tag's default is written over an empty span where its name
    // would be: the shorthand has no authored name.
    const span = node.name?.span ?? { start: node.start, end: node.start };
    const end = node.name?.kind === "unnamed" ? span.start : span.end;
    return spanOf(span.start, end);
  });
  lazy(view, "attributes", () =>
    Object.freeze(
      tagAttributesOf(node).map((attr: Node) => hostAttributeViewOf(ctx, attr)),
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
    const span = rangeOf(node.params);
    return span
      ? Object.freeze({ span, count: tagParamsOf(node).length })
      : null;
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
 * The entry of one attribute: an `MxAttribute`/`MxSpreadAttribute`, or a
 * record the name-sugar rewrite built in their place.
 */
export function hostAttributeViewOf(
  ctx: Ctx,
  attr: Node,
): HostAttributeView | HostSpreadView {
  return cached(ctx, attr, () => buildAttributeView(ctx, attr));
}

function buildAttributeView(
  ctx: Ctx,
  attr: Node,
): HostAttributeView | HostSpreadView {
  // A shorthand's record (`<x.a#b>`'s merged `class`, its `id`) carries no
  // position of its own: it reports at its value, the shorthand's text,
  // where the Marko-shaped view had none to give.
  const span = rangeOf(attr) ?? locatedRangeOf(ctx, attr.value) ?? spanOf(0, 0);
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
  lazy(view, "nameSpan", () => {
    const named = attr.nameSpan ?? attr.sugarNameSpan;
    if (typeof named?.start === "number") {
      return spanOf(named.start, named.end);
    }
    return spanOf(span.start, span.start);
  });
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

/**
 * The span of the binding identifier `name` declares inside `target`, the
 * first in source order: `target` is a view or handle (its tag variable) or
 * a binding pattern payload (a Babel pattern, as `checkBinding` receives).
 * `null` when the pattern binds no such name (ast §6.4).
 *
 * @unstable decision 197, PR 6.
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
