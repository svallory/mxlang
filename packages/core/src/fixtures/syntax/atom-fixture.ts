/**
 * A test dialect whose atoms are a node type: `Atom` (`atom:Atom`), a name
 * the author writes `~name`. It writes one in all three places a dialect
 * can, and claims the contract keys that say which atoms a slot allows. Core
 * has no atom syntax and checks none of these keys: what a claimed key
 * means is this file's choice. Core knows an atom only as a node of a
 * registered type (`Expr.nodes`, `Attr.node`) and its forward, the string
 * literal its type's `lower` returns. The literal carries no mark.
 *
 * Where an atom is written (the sigil is `~`):
 *
 * - in an expression, `x=(a + ~b)`: the expression row claims an `Atom`
 *   node, which lowers to the literal `"b"`, listed in `Expr.nodes`;
 * - as a whole attribute value, `x=~b`: the value row claims the same node
 *   type, so the attribute is static, with the node on `Attr.node`;
 * - in an attribute list, `kind ~b`: the `{ call }` row's hook builds an
 *   `atom:Atom` node and places it as the value of a `name` attribute
 *   (`ctx.attribute`), lowered through the type's `lower` like a claimed
 *   value.
 *
 * What it claims: `values`, `pattern` and `ref` (attribute keys) and
 * `declares` (a tag key), as opaque data. `checkContract` checks the shape of
 * `values`; `afterLower` checks an atom against its attribute's `values`
 * (every other claimed key it leaves alone); `describeAttribute` words the
 * `values` in core's whole-value shape error. The messages are this file's
 * own.
 *
 * It uses the public hook API only and imports types only, so a test can
 * load it through Node's strip-only `require` as a dialect package's module
 * (no enums or parameter properties).
 */
import type { Dialect, Trigger } from "../../index.ts";

const NAME = "~[a-z][a-z0-9-]*";

/** An atom in an expression or as a whole `=value`: the node type below lowers it. */
export const ATOM_NODE: Trigger = Object.freeze({
  id: "atom-node",
  chars: "~",
  match: NAME,
  standIn: "identifier",
  node: Object.freeze({ type: "Atom", dialect: "atom" }),
});

/** The atom row in an attribute list (`{ call }`): the hook places an `Atom` node. */
export const ATOM: Trigger = Object.freeze({
  id: "atom",
  chars: "~",
  match: NAME,
  standIn: "identifier",
  node: Object.freeze({ call: "atom" }),
});

/** Kept for the tests that name the value row: the same row as `ATOM_NODE`. */
export const ATOM_VALUE: Trigger = ATOM_NODE;

/** The node an `Atom` is: its name, without the sigil. */
export interface AtomNode {
  readonly type: "atom:Atom";
  readonly name: string;
  readonly span: { readonly sourceStart: number; readonly sourceEnd: number };
}

/** The literal an atom lowers to: a plain string literal, no mark. */
function atomLiteral(name: string) {
  return {
    type: "StringLiteral",
    value: name,
    extra: { raw: JSON.stringify(name), rawValue: name },
  };
}

function valuesOf(declaration: Readonly<Record<string, unknown>> | undefined) {
  const values = declaration?.values;
  return Array.isArray(values) && values.every((v) => typeof v === "string")
    ? (values as string[])
    : undefined;
}

const atomSyntax = {
  id: "atom",
  name: "Fixture",
  table: Object.freeze({
    expressionTriggers: [ATOM_NODE],
    attributeTriggers: [ATOM],
    valueTriggers: [ATOM_NODE],
  }),
  nodeTypes: {
    Atom: {
      keys: [],
      parse: (text: string) => ({ name: text.slice(1) }),
      print: (node: { name: string }) => `~${node.name}`,
      lower: (node: { name: string }, ctx) =>
        ctx.expression(atomLiteral(node.name)),
    },
  },
  lowerTrigger(_id, text, span, ctx) {
    // Only the attribute-list row is a `{ call }` row.
    void span;
    return ctx.attribute("name", text.slice(1));
  },
  contractFields: {
    attribute: ["values", "pattern", "ref"],
    tag: ["declares"],
  },
  checkContract(tag, contract, ctx) {
    for (const [name, declaration] of Object.entries(
      contract.attributes ?? {},
    )) {
      if (declaration.values !== undefined && !valuesOf(declaration)) {
        ctx.fail(
          `\`<${tag}>\`: \`${name}\`: \`values\` must be an array of strings`,
          { code: "FIXTURE_VALUES" },
        );
      }
    }
  },
  describeAttribute(declaration) {
    const values = valuesOf(declaration);
    return values ? ` (one of ${values.map((v) => `~${v}`).join(", ")})` : "";
  },
  afterLower(unit) {
    for (const call of unit.calls) {
      for (const attr of call.attrs) {
        if ("spread" in attr || attr.value?.type !== "atom:Atom") continue;
        // `type` does not narrow a dialect's node: this file's own node type.
        const atom = attr.value as unknown as AtomNode;
        const values = valuesOf(call.contract.attributes?.[attr.name]);
        if (!values || values.includes(atom.name)) continue;
        unit.fail(
          `\`<${call.tag}>\`: attribute ${attr.label}: \`~${atom.name}\` is not one of ${values.map((v) => `~${v}`).join(", ")}`,
          atom.span ? { at: atom.span } : undefined,
        );
      }
    }
  },
} satisfies Dialect;

export default Object.freeze(atomSyntax) as Dialect;
