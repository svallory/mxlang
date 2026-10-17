/**
 * Which dialect node an expression stands for. A node's type `lower`s it to
 * an expression (its forward), which core places in the payload where the
 * node was written; `Expr.nodes` lists them by their printed range. This
 * module keeps each forward's entry so the contract checks
 * (`custom-tags.ts`) can tell a node from the string literal or expression
 * it lowered to, without reading any mark. It imports nothing at run time,
 * so the registration path (`scan.ts`) can load it.
 */

import type { DialectNode } from "./dialect-registry.ts";
import type { ExprNode } from "./ir.ts";

/** Each dialect node's entry, keyed by its forward. */
const forwards = new WeakMap<object, Omit<ExprNode, "code">>();

/** The dialect node `forward` stands for, or `undefined`. */
export function nodeOfForward(forward: unknown): DialectNode | undefined {
  return forward && typeof forward === "object"
    ? forwards.get(forward)?.node
    : undefined;
}

/**
 * Records `forward` as the expression `node` lowered to, and returns the
 * entry `Expr.nodes` lists (without its printed range, which `expr()` adds).
 */
export function recordForward(
  node: DialectNode,
  forward: object,
): Omit<ExprNode, "code"> {
  const entry = Object.freeze({
    type: node.type,
    span: node.span,
    node,
    forward,
  }) as Omit<ExprNode, "code">;
  forwards.set(forward, entry);
  return entry;
}

/** Keys of a Babel node that hold no child expression. */
const NOT_CHILDREN = new Set([
  "loc",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "typeAnnotation",
  "returnType",
  "typeParameters",
]);

/**
 * The dialect nodes whose forwards sit inside `node`, found by identity, in
 * source order. For an expression `expr()` prints by generating it (a method
 * value, `onClick() { return ~a }`, has no source range of its own): there
 * is no splice to carry the node, so the payload is walked instead. The
 * entries have no printed range.
 */
export function nodesInside(node: unknown): Omit<ExprNode, "code">[] {
  const found: Omit<ExprNode, "code">[] = [];
  const seen = new WeakSet<object>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const entry = forwards.get(value);
    if (entry) {
      found.push(entry);
      return;
    }
    if (Array.isArray(value)) {
      for (const each of value) walk(each);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (!NOT_CHILDREN.has(key)) walk(child);
    }
  };
  walk(node);
  return found.sort((a, b) => a.span.sourceStart - b.span.sourceStart);
}
