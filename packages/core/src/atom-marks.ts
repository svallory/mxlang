import type { Ctx, Node } from "./core.ts";
import type { Atom, MxAtomMark } from "./ir.ts";

/**
 * Atom marks. Core lexes no atom: a dialect builds one through its syntax
 * table (an expression trigger whose `lower` returns
 * `ctx.expression(node)`), and marks the node it returns with
 * `extra.mxAtom = { span }` (`MxAtomMark`, public API of `@mxlang/core`).
 * This pass records every marked node on `ctx.atoms`, in source order, so
 * `expr()` splices each one into the authored slice and the source map maps
 * it, as it does for any other replaced trigger. What an atom means, and
 * which uses of one are errors, is the dialect's.
 */

/** Keys that never lead to an expression node. */
const SKIP = new Set([
  "loc",
  "extra",
  "start",
  "end",
  "range",
  "errorLoc",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);

/** The atom a marked node stands for, or `undefined` for any other node. */
export function atomOf(node: Node): Atom | undefined {
  const mark: MxAtomMark | undefined = node?.extra?.mxAtom;
  if (node?.type !== "StringLiteral" || !mark) return undefined;
  return { kind: "atom", name: node.value, span: mark.span };
}

/**
 * Records every atom-marked node under `roots` on `ctx.atoms` (source
 * order), which `expr()` splices into the authored slice. Idempotent: a
 * node already recorded is recorded again at the same offset, so a second
 * walk over the same tree (a scratch `Ctx`) sees the same atoms.
 */
export function recordAtoms(ctx: Ctx, roots: readonly Node[]): void {
  const found = new Map<number, Atom>(
    (ctx.atoms ?? []).map((atom) => [atom.span.sourceStart, atom]),
  );
  const seen = new WeakSet<object>();
  const visit = (node: Node): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const atom = atomOf(node);
    if (atom) {
      found.set(atom.span.sourceStart, atom);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (SKIP.has(key) || !child || typeof child !== "object") continue;
      visit(child);
    }
  };
  for (const root of roots) visit(root);
  ctx.atoms = [...found.values()].sort(
    (a, b) => a.span.sourceStart - b.span.sourceStart,
  );
}

/** The atoms whose span lies inside `[start, end)`, in source order. */
export function atomsIn(ctx: Ctx, start: number, end: number): Atom[] {
  return (ctx.atoms ?? []).filter(
    (atom) => atom.span.sourceStart >= start && atom.span.sourceEnd <= end,
  );
}
