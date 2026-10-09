/**
 * The Marko-shaped view of an MX node that core hands a host hook (decision
 * 163 addendum, option A; port PR 5).
 *
 * The public `HostDeclarations` hooks (`resolveDelegatedTag`,
 * `rejectModifier`, `resolveDefaultTag`, …) were written against Marko's
 * tree: hosts read `node.name`, `node.var`, `node.body.body`,
 * `node.attributes`, `attr.value`, `attr.modifier` and position errors from
 * `node.loc`. Production now parses with the MX front end, whose nodes carry
 * offsets (`start`/`end`), name field shapes and expression containers
 * instead. Rather than every host learning the MX AST, core builds one view:
 *
 * - **tag** (`MxTag`, `MxReturn`, `MxAttributeTag`): `type: "MarkoTag"`,
 *   `name` (a `StringLiteral`, or the Babel expression of a dynamic name),
 *   `var`, `arguments`, `typeArguments`, `attributes` (viewed),
 *   `attributeTags` (viewed; Marko moves attribute tags, and control flow
 *   holding them, out of the body), `body: { body, params, typeParameters }`
 *   (children viewed);
 * - **attribute** (`MxAttribute`, `MxSpreadAttribute`): `type:
 *   "MarkoAttribute"`/`"MarkoSpreadAttribute"`, `name` (the default value is
 *   `value`), `value` (a Babel node; a method is its `FunctionExpression`),
 *   `modifier`, `bound`, `default`, `arguments`;
 * - **other children**: Marko's text, placeholder, comment, scriptlet, CDATA,
 *   doctype and declaration kinds with their `value`; an MX-only kind keeps
 *   its `type`;
 * - **every view**: Marko's `loc` (`{ start: { line, column, index }, end }`,
 *   1-based line, 0-based column, from `ctx.lines`) and `start`/`end`.
 *
 * Rules: one view per node and `Ctx` (a `WeakMap` per `Ctx`, so identity is
 * stable across the several hooks a tag meets in one compile, while a second
 * `Ctx` over another source gets its own view and its own `loc`), every field
 * computed on first read, the view
 * and its arrays frozen (nothing writes back to the MX tree), no host names,
 * and a node that is not an MX node (a Babel payload, a Marko node, the
 * Marko-shaped records `rewriteMxSugar` builds) is returned as it is.
 *
 * TODO(mx-node-handle): every hook below moves to an `MxNodeHandle` and this
 * adapter goes. One line per hook that receives a view today:
 * - TODO(mx-node-handle): `resolveDelegatedTag(name, node, ctx)`
 * - TODO(mx-node-handle): `rejectModifier(attr, on)`
 * - TODO(mx-node-handle): `resolveModifier(attr, on)`
 * - TODO(mx-node-handle): `rejectAttributeMethod(attr, on)`
 * - TODO(mx-node-handle): `resolveAttributeMethod(attr, on)` (also handed a tag by the tag-arguments hint)
 * - TODO(mx-node-handle): `resolveDefaultTag(node, parents, context)` and `DefaultTagParent.node`
 * - TODO(mx-node-handle): `rejectElementAttributeTags(name, node, ctx)`
 * - TODO(mx-node-handle): `rejectComponentTag(name, node, ctx)`
 * - TODO(mx-node-handle): `rejectUnknownTag(name, node, ctx)`
 * - TODO(mx-node-handle): `checkBinding(target, what)` (a Babel pattern today, not viewed)
 */
import {
  attrArgsOf,
  attrNameOf,
  attrValueOf,
  isBoundAttr,
  isDefaultAttr,
} from "./attr-fields.ts";
import { type Ctx, type Node, positionAtOffset } from "./core.ts";
import { payloadOf } from "./payload.ts";
import {
  tagArgsOf,
  tagAttributesOf,
  tagNameExprOf,
  tagNameOf,
  tagParamsOf,
  tagVarOf,
} from "./tag-fields.ts";

/**
 * One view per MX node *per `Ctx`*: a view's `loc` and `attr.value` are read
 * through the `Ctx` that built it (its `lines`, its bindings), so a node
 * reached from two compiles (a scratch `analyze` walk, a host that lowers one
 * fragment twice over different sources) must not hand the second the
 * first's positions.
 */
const views = new WeakMap<Ctx, WeakMap<object, Node>>();

/** The MX node each view stands for (`mxNodeOf`). */
const sources = new WeakMap<object, Node>();

/** Marko's control flow, which Marko moves to `attributeTags` when it holds attribute tags. */
const CONTROL_FLOW = new Set(["if", "else-if", "else", "for", "while"]);

/** MX child kinds with a Marko counterpart that carries a `value` string. */
const VALUE_KINDS: Readonly<Record<string, string>> = {
  MxText: "MarkoText",
  MxComment: "MarkoComment",
  MxCDATA: "MarkoCDATA",
  MxDoctype: "MarkoDocumentType",
  MxDeclaration: "MarkoDeclaration",
};

function isMxNode(node: Node): boolean {
  return (
    node !== null &&
    typeof node === "object" &&
    typeof node.type === "string" &&
    node.type.startsWith("Mx")
  );
}

function isMxTag(node: Node): boolean {
  const type = node?.type;
  return type === "MxTag" || type === "MxReturn" || type === "MxAttributeTag";
}

/**
 * The Marko-shaped, read-only view of `node` that a host hook receives. A
 * node that is not an MX node (including `null`/`undefined`) is returned
 * unchanged.
 */
export function markoViewOf(ctx: Ctx, node: Node): Node {
  if (!isMxNode(node)) return node;
  let perCtx = views.get(ctx);
  if (!perCtx) {
    perCtx = new WeakMap();
    views.set(ctx, perCtx);
  }
  const known = perCtx.get(node);
  if (known) return known;
  const view = buildView(ctx, node);
  perCtx.set(node, view);
  sources.set(view, node);
  return view;
}

/** The MX node behind a view, or `node` itself when it is not one. */
export function mxNodeOf(node: Node): Node {
  return (node && typeof node === "object" && sources.get(node)) || node;
}

/** Marko's `loc` for `[start, end)`: 1-based line, 0-based column, plus the offset. */
function locOf(ctx: Ctx, start: number, end: number): Node {
  const from = positionAtOffset(ctx, start);
  const to = positionAtOffset(ctx, end);
  return Object.freeze({
    start: Object.freeze({
      line: from.line,
      column: from.column,
      index: start,
    }),
    end: Object.freeze({ line: to.line, column: to.column, index: end }),
  });
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

function frozenList<T>(
  list: readonly T[] | undefined | null,
): readonly T[] | undefined {
  return list ? Object.freeze([...list]) : undefined;
}

function buildView(ctx: Ctx, node: Node): Node {
  const view: Record<string, unknown> = { start: node.start, end: node.end };
  lazy(view, "loc", () => locOf(ctx, node.start, node.end));
  if (isMxTag(node)) tagView(ctx, node, view);
  else if (node.type === "MxAttribute") attributeView(ctx, node, view);
  else if (node.type === "MxSpreadAttribute") {
    view.type = "MarkoSpreadAttribute";
    lazy(view, "value", () => payloadOf(node.value));
  } else if (node.type === "MxPlaceholder") {
    view.type = "MarkoPlaceholder";
    view.escape = node.escape;
    lazy(view, "value", () => payloadOf(node.expression));
  } else if (node.type === "MxScriptlet") {
    view.type = "MarkoScriptlet";
    view.static = false;
    lazy(view, "body", () => frozenList(payloadOf(node.code)));
  } else {
    view.type = VALUE_KINDS[node.type] ?? node.type;
    if (typeof node.value === "string") view.value = node.value;
  }
  return Object.freeze(view);
}

function tagView(ctx: Ctx, node: Node, view: Record<string, unknown>): void {
  view.type = "MarkoTag";
  const memos = new Map<string, unknown>();
  const memo = (key: string, compute: () => unknown): unknown => {
    if (!memos.has(key)) memos.set(key, compute());
    return memos.get(key);
  };
  // An unnamed tag's name changes once when `resolveDefaultTag` answers, so
  // the literal is rebuilt only when the resolved spelling changes.
  let literal: { value: string | undefined; node: Node } | undefined;
  Object.defineProperty(view, "name", {
    enumerable: true,
    get() {
      if (node.type === "MxTag" || node.type === "MxReturn") {
        if (node.name?.kind === "dynamic") {
          return memo("dynamicName", () => tagNameExprOf(node));
        }
      }
      const value = tagNameOf(node);
      if (!literal || literal.value !== value) {
        // Marko writes the default tag over an empty span: the shorthand
        // has no authored name.
        const span = node.name?.span ?? { start: node.start, end: node.start };
        const end = node.name?.kind === "unnamed" ? span.start : span.end;
        literal = {
          value,
          node: Object.freeze({
            type: "StringLiteral",
            value: value ?? "",
            start: span.start,
            end,
            loc: locOf(ctx, span.start, end),
          }),
        };
      }
      return literal.node;
    },
  });
  lazy(view, "var", () => tagVarOf(node) ?? null);
  lazy(view, "arguments", () => frozenList(tagArgsOf(node)));
  lazy(view, "typeArguments", () =>
    node.typeArgs ? payloadOf(node.typeArgs) : undefined,
  );
  lazy(view, "attributes", () =>
    Object.freeze(
      tagAttributesOf(node).map((attr: Node) => markoViewOf(ctx, attr)),
    ),
  );
  const split = () =>
    memo("split", () => {
      const content: Node[] = [];
      const attributeTags: Node[] = [];
      for (const child of node.body ?? []) {
        (holdsAttributeTags(child) ? attributeTags : content).push(child);
      }
      return { content, attributeTags };
    }) as { content: Node[]; attributeTags: Node[] };
  lazy(view, "attributeTags", () =>
    Object.freeze(split().attributeTags.map((tag) => markoViewOf(ctx, tag))),
  );
  lazy(view, "body", () => {
    const body: Record<string, unknown> = { type: "MarkoTagBody" };
    lazy(body, "body", () =>
      Object.freeze(split().content.map((child) => markoViewOf(ctx, child))),
    );
    lazy(body, "params", () => frozenList(tagParamsOf(node)));
    lazy(body, "typeParameters", () =>
      node.typeParams ? payloadOf(node.typeParams) : undefined,
    );
    return Object.freeze(body);
  });
}

/** An attribute tag, or control flow holding one (Marko's `attributeTags`). */
function holdsAttributeTags(child: Node): boolean {
  if (child?.type === "MxAttributeTag") return true;
  if (child?.type !== "MxTag" || child.name?.kind !== "static") return false;
  if (!CONTROL_FLOW.has(child.name.value)) return false;
  return (child.body ?? []).some(holdsAttributeTags);
}

function attributeView(
  ctx: Ctx,
  attr: Node,
  view: Record<string, unknown>,
): void {
  view.type = "MarkoAttribute";
  view.name = attrNameOf(attr);
  view.modifier = attr.modifier;
  view.bound = isBoundAttr(attr);
  view.default = isDefaultAttr(attr);
  lazy(view, "value", () => attrValueOf(ctx, attr));
  lazy(view, "arguments", () => frozenList(attrArgsOf(attr)));
}
