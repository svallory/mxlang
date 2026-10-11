/**
 * A test dialect for core's contract-field claims: it claims the contract
 * keys `ref` (an attribute key) and `declares` (a tag key), and checks them
 * from `afterLower` through the public unit view. Its only syntax is the atom
 * fixture's `~name` rows (`atom-fixture.ts`), restated here under this
 * dialect's id because a row names a node type of its own dialect. It is not
 * shipped.
 *
 * A tag that `declares: { kind, from }` declares the value of its `from`
 * attribute as a name of that kind; an attribute with `ref: kind` must hold a
 * `~name` atom some tag declared. The messages are this fixture's own.
 *
 * It imports types only, so a test can load it through Node's strip-only
 * `require` as a dialect package's module.
 */
import type { Dialect, LoweredUnit, Trigger } from "../../index.ts";

const NAME = "~[a-z][a-z0-9-]*";

/** The atom row in an expression and an attribute list (`{ call }`). */
const ATOM: Trigger = Object.freeze({
  id: "atom",
  chars: "~",
  match: NAME,
  standIn: "identifier",
  node: Object.freeze({ call: "atom" }),
});

/** The atom row on a whole `=value`: the node type below lowers it. */
const ATOM_VALUE: Trigger = Object.freeze({
  id: "atom-value",
  chars: "~",
  match: NAME,
  standIn: "identifier",
  node: Object.freeze({ type: "Atom", dialect: "fixture" }),
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

function nameOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { type, name, value: text } = value as Record<string, unknown>;
  if (type === "mx:Atom" && typeof name === "string") return name;
  if (type === "mx:String" && typeof text === "string") return text;
  return undefined;
}

function check(unit: LoweredUnit): void {
  const declared = new Map<string, string[]>();
  for (const call of unit.calls) {
    const declares = call.contract.declares as
      | { kind: string; from: string }
      | undefined;
    if (!declares) continue;
    const attr = call.attrs.find(
      (each) => !("spread" in each) && each.name === declares.from,
    );
    const name = attr && !("spread" in attr) ? nameOf(attr.value) : undefined;
    if (name === undefined) continue;
    declared.set(declares.kind, [...(declared.get(declares.kind) ?? []), name]);
  }
  for (const call of unit.calls) {
    for (const attr of call.attrs) {
      if ("spread" in attr) continue;
      const ref = call.contract.attributes?.[attr.name]?.ref;
      const name = nameOf(attr.value);
      if (typeof ref !== "string" || name === undefined) continue;
      const known = declared.get(ref) ?? [];
      if (known.includes(name)) continue;
      const value = attr.value as {
        span?: { sourceStart: number; sourceEnd: number };
      } | null;
      unit.fail(
        `\`<${call.tag}>\`: attribute \`${attr.name}\`: \`~${name}\` is not a declared ${ref} here (one of ${known.map((each) => `~${each}`).join(", ")})`,
        value?.span ? { at: value.span } : undefined,
      );
    }
  }
}

const declaresFixture = {
  id: "fixture",
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
  contractFields: { attribute: ["ref"], tag: ["declares"] },
  afterLower: check,
} satisfies Dialect;

export default Object.freeze(declaresFixture) as Dialect;
