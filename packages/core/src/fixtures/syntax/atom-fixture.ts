/**
 * A test dialect for core's atom values: it builds atoms (a name the module
 * writes `~name`) in all three places a module can, and claims the contract
 * keys that say which atoms a slot allows. Core has no atom syntax and checks
 * none of these keys: what a claimed key means is this file's choice.
 *
 * Where it builds an atom (the sigil is `~`, so it never meets core's own
 * built-in lexing):
 *
 * - in an expression, `x=(a + ~b)` is a `StringLiteral` marked
 *   `extra.mxAtom = { span, name }` (`ctx.expression`);
 * - as a whole attribute value, `x=~b` is the same literal, from the value
 *   row's node type (`Atom`), so the attribute keeps the atom mark;
 * - in an attribute list, `kind ~b` is a static attribute `name` whose value
 *   is `{ kind: "atom", name }` (`ctx.attribute`).
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
import type { ContractAtomOrMember, Dialect, Trigger } from "../../index.ts";

const NAME = "~[a-z][a-z0-9-]*";

/** The atom row in an expression and an attribute list (`{ call }`). */
export const ATOM: Trigger = Object.freeze({
  id: "atom",
  chars: "~",
  match: NAME,
  standIn: "identifier",
  node: Object.freeze({ call: "atom" }),
});

/** The atom row on a whole `=value`: the node type below lowers it. */
export const ATOM_VALUE: Trigger = Object.freeze({
  id: "atom-value",
  chars: "~",
  match: NAME,
  standIn: "identifier",
  node: Object.freeze({ type: "Atom", dialect: "atom" }),
});

/** The literal an atom lowers to in an expression or a value position. */
function atomLiteral(
  name: string,
  span: { sourceStart: number; sourceEnd: number },
) {
  return {
    type: "StringLiteral",
    value: name,
    extra: {
      raw: JSON.stringify(name),
      rawValue: name,
      mxAtom: { span, name },
    },
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
    expressionTriggers: [ATOM],
    attributeTriggers: [ATOM],
    valueTriggers: [ATOM_VALUE],
  }),
  nodeTypes: {
    Atom: {
      keys: [],
      parse: (text: string) => ({ name: text.slice(1) }),
      print: (node: { name: string }) => `~${node.name}`,
      lower: (node: { name: string; span: never }, ctx) =>
        ctx.expression(atomLiteral(node.name, node.span)),
    },
  },
  lowerTrigger(_id, text, span, ctx) {
    const name = text.slice(1);
    if (ctx.position === "attribute") {
      return ctx.attribute("name", { kind: "atom", name, span });
    }
    return ctx.expression(atomLiteral(name, span));
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
        if ("spread" in attr || attr.value?.type !== "mx:Atom") continue;
        // `type` does not narrow a dialect's node: the atom's own view type.
        const atom = attr.value as ContractAtomOrMember;
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
