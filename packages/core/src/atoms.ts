import { type Ctx, fail, type Node, TranslateError } from "./core.ts";
import type { Atom, MxAtomMark } from "./ir.ts";

/**
 * Atoms (decision 156; ADR `design-notes/adr-atoms.md`, "Parser approach").
 *
 * MX's htmljs-parser lexes `:name` in an expression position and hands Babel a
 * numeric stand-in of the same length (`:a` is `0.`, `:rename-all` is
 * `0.000000000`), so every offset in the expression stays exact. This pass
 * turns each stand-in back into what the language means: a `StringLiteral`
 * whose value is the name, marked with `extra.mxAtom = { span }` (decision 156
 * addendum 1, item 1; public API of `@mxlang/core` and `@mxlang/data`). It runs
 * on the parsed tree before anything reads an expression, from `lower` and
 * from an external `lowerChildren` call (`parseFragment`'s hosts), so every
 * target, the data tree and the type-check projection see the string.
 *
 * A stand-in is recognised by the source character at its start: no authored
 * numeric literal starts with `:`, so the check cannot be forged.
 *
 * Misuse Babel accepts on a number is rejected here, positioned at the atom:
 * member access, calls, unary operators, spreading, and a non-computed object
 * key. The misuse a number cannot express (`:a = 1`, `(:a) => 1`, `{:a}`) is a
 * Babel parse error; `parse-error-hints.ts` names the atom in it.
 */

/** The internal error for a stand-in that reached lowering unconverted. */
export const ATOM_STAND_IN_MESSAGE =
  "internal error: an atom stand-in reached lowering unconverted (decision 156); core converts every `:name` before it reads an expression";

/** `[A-Za-z_$][\w$]*(-[\w$]+)*`: the atom name rule, the 146 sugar token without a trailing dash. */
const ATOM_NAME = /^[A-Za-z_$][\w$]*(?:-[\w$]+)*$/;

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

function offsets(node: Node): [number, number] | undefined {
  const start = node?.loc?.start?.index ?? node?.start;
  const end = node?.loc?.end?.index ?? node?.end;
  return typeof start === "number" && typeof end === "number"
    ? [start, end]
    : undefined;
}

/** Is `node` the parser's stand-in for an atom, still unconverted? */
function isStandIn(ctx: Ctx, node: Node): boolean {
  if (node?.type !== "NumericLiteral") return false;
  const at = offsets(node);
  return !!at && ctx.source[at[0]] === ":";
}

/** The atom a converted node stands for, or `undefined` for any other node. */
export function atomOf(node: Node): Atom | undefined {
  const mark: MxAtomMark | undefined = node?.extra?.mxAtom;
  if (node?.type !== "StringLiteral" || !mark) return undefined;
  return { kind: "atom", name: node.value, span: mark.span };
}

function misuse(name: string, what: string): string {
  return `\`:${name}\` is an atom (decision 156), a name and not a value to operate on: ${what} is not allowed on it; write \`"${name}"\` for a string you mean to operate on`;
}

/** The positioned error for an atom where only a non-atom can stand, if any. */
function rejectMisuse(name: string, node: Node, parent: Node, key: string) {
  switch (parent?.type) {
    case "MemberExpression":
    case "OptionalMemberExpression":
      if (key === "object") fail(misuse(name, "member access"), node);
      return;
    case "CallExpression":
    case "OptionalCallExpression":
    case "NewExpression":
      if (key === "callee") fail(misuse(name, "a call"), node);
      return;
    case "TaggedTemplateExpression":
      if (key === "tag") fail(misuse(name, "a call"), node);
      return;
    case "UnaryExpression":
      fail(misuse(name, `the unary operator \`${parent.operator}\``), node);
      return;
    case "SpreadElement":
    case "MarkoSpreadAttribute":
      // `f(...:a)`, `[...:a]` and a tag's `<div ...:a/>` alike.
      fail(misuse(name, "spreading"), node);
      return;
    default:
      if (key === "key" && !parent?.computed) {
        fail(
          `\`:${name}\` cannot be an object key: an atom is a value (decision 156); write \`${name}:\` for the key, or \`[:${name}]\` to compute it from the atom`,
          node,
        );
      }
  }
}

/**
 * Converts every atom stand-in under `roots` and records each atom on
 * `ctx.atoms` (source order), which `expr()` splices into the authored slice.
 * Idempotent: a node already converted is recorded again, not converted
 * twice, so a second walk over the same tree (a scratch `Ctx`) sees the same
 * atoms.
 */
export function convertAtoms(ctx: Ctx, roots: readonly Node[]): void {
  const found = new Map<number, Atom>(
    (ctx.atoms ?? []).map((atom) => [atom.span.sourceStart, atom]),
  );
  const seen = new WeakSet<object>();
  const visit = (node: Node, parent: Node, key: string): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parent, key);
      return;
    }
    if (typeof node.type !== "string") return;
    if (isStandIn(ctx, node)) {
      const [start, end] = offsets(node) as [number, number];
      const name = ctx.source.slice(start + 1, end);
      if (!ATOM_NAME.test(name)) fail(ATOM_STAND_IN_MESSAGE, node);
      rejectMisuse(name, node, parent, key);
      const span = { sourceStart: start, sourceEnd: end };
      node.type = "StringLiteral";
      node.value = name;
      node.extra = {
        raw: JSON.stringify(name),
        rawValue: name,
        mxAtom: { span },
      };
    }
    const atom = atomOf(node);
    if (atom) {
      found.set(atom.span.sourceStart, atom);
      return;
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (SKIP.has(childKey) || !child || typeof child !== "object") continue;
      visit(child, node, childKey);
    }
  };
  for (const root of roots) visit(root, null, "");
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

/**
 * Core's assertion that no stand-in survives its conversion (the lead's
 * ruling on the stand-in leak): an expression about to be lowered holds none.
 * Walks only an expression whose authored text has a `:` in it.
 */
export function assertNoStandIn(ctx: Ctx, node: Node): void {
  const at = offsets(node);
  if (at && !ctx.source.slice(at[0], at[1]).includes(":")) return;
  const seen = new WeakSet<object>();
  const visit = (value: Node): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isStandIn(ctx, value)) {
      const start = value.loc?.start;
      throw new TranslateError(
        ATOM_STAND_IN_MESSAGE,
        start?.line ?? 0,
        start?.column ?? 0,
      );
    }
    for (const [key, child] of Object.entries(value)) {
      if (!SKIP.has(key)) visit(child);
    }
  };
  visit(node);
}
