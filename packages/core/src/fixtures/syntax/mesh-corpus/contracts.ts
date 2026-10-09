/**
 * Mesh's closed entity-file contracts, copied from Mesh
 * (`packages/compiler/src/contracts.ts`; commit and licence in this
 * directory's README.md and LICENSE). Two import lines differ from the
 * original: core's types come from core's own source, and `@meshfw/model`'s
 * two lists from `./model.ts`. Everything else is Mesh's.
 */
import type {
  Attr,
  ContractMap,
  CustomTag,
  CustomTagAttribute,
  TagCall,
} from "../../../index.ts";
import { ACTION_TYPES, ATTRIBUTE_TYPES as REGISTRY } from "./model.ts";

export { ACTION_TYPES } from "./model.ts";
export const ATTRIBUTE_TYPES = REGISTRY.map((t) => t.name);
export const ROLLUPS = ["count", "sum", "avg", "min", "max"] as const;

/** Layer-1 vocabulary only: no transforms, evaluation, or source rewriting. */
const closed = (def: CustomTag): CustomTag => ({
  attributes: {},
  attributeTags: {},
  children: {},
  ...def,
});
const atom = (required = false): CustomTagAttribute => ({
  type: "atom",
  required,
  pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
});
const text = (required = false): CustomTagAttribute => ({
  type: "string",
  literalOnly: true,
  required,
});
const flag = (): CustomTagAttribute => ({ type: "boolean", literalOnly: true });
const number = (): CustomTagAttribute => ({
  type: "number",
  literalOnly: true,
});
const fn = (required = false): CustomTagAttribute => ({
  type: "function",
  required,
});
const named = () => ({ name: atom(true) });
const children = (...names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, { repeatable: true }]));
const get = (call: TagCall, name: string) =>
  call.attrs.find((a) => a.kind !== "spread" && a.name === name);
interface Node {
  type: string;
  name?: string;
  value?: unknown;
  extra?: { mxMember?: unknown; mxAtom?: unknown };
  elements?: (Node | null)[];
}
const node = (a: Attr | undefined): Node | undefined =>
  a && (a.kind === "dynamic" || a.kind === "bound")
    ? (a.value.node as Node | undefined)
    : undefined;
const isMember = (n: Node | null | undefined) =>
  n?.type === "MemberExpression" && !!n.extra?.mxMember;
/** A slot that holds one member only (MX decision 182 addendum 4): MX checks
 * the `&name` form, after a kind or as a whole value; Mesh resolves membership. */
const member = (required = false): CustomTagAttribute => ({
  type: "member",
  required,
});
/** A list of members (`actions=[&publish]`): MX's `"member"` type takes one
 * member, so a list is an array whose elements Mesh checks for marks. */
const members = (): CustomTagAttribute => ({ type: "array" });
function references(lists: string[]): NonNullable<CustomTag["analyze"]> {
  return (calls, ctx) => {
    for (const call of calls) {
      for (const key of lists) {
        const a = get(call, key);
        if (!a) continue;
        const n = node(a);
        if (n?.type !== "ArrayExpression" || !n.elements?.every(isMember))
          ctx.fail(
            `MESH_MEMBER_REFERENCE: \`${key}\` requires a list of member references`,
            a.loc,
          );
      }
    }
  };
}
const scope = () => ({
  types: { type: "atom", values: [...ACTION_TYPES] } as CustomTagAttribute,
  actions: members(),
});
const options = (type: string) => ({
  nullable: flag(),
  default: { literalOnly: true },
  ...(type === "enum" ? { values: atom() } : {}),
  ...(["string", "integer", "float", "decimal"].includes(type)
    ? { min: number(), max: number() }
    : {}),
  ...(type === "string" ? { match: { type: "expression" as const } } : {}),
});
const steps = children("set", "when", "load", "run");
const body = { validate: {}, do: {} };
// The `member` child MX lowers a tagless `&name` line to (`MESH_SYNTAX`). An
// inline wildcard contract, so no `member` tag is authorable at large; under
// input/set the builder still refuses an authored `member name="x"`.
const memberLine = (attributes: Record<string, CustomTagAttribute>) => ({
  pattern: "member",
  attributes: {
    name: { type: "string", required: true } as CustomTagAttribute,
    ...attributes,
  },
  attributeTags: {},
  children: {},
});

const contracts: ContractMap = {
  entity: closed({
    parents: ["#root"],
    attributes: { ...named(), table: text() },
    children: {
      attributes: {},
      relationships: {},
      computed: {},
      actions: {},
      policies: {},
    },
  }),
  attributes: closed({
    parents: ["entity"],
    children: children(...ATTRIBUTE_TYPES),
  }),
  relationships: closed({
    parents: ["entity"],
    children: children("belongs-to", "has-many", "has-one"),
  }),
  computed: closed({
    parents: ["entity"],
    children: children(...ATTRIBUTE_TYPES, ...ROLLUPS),
  }),
  actions: closed({
    parents: ["entity"],
    attributes: {
      auto: { type: "atom", values: [...ACTION_TYPES] },
      "on:load": member(),
    },
    children: children(...ACTION_TYPES, "always"),
  }),
  always: closed({
    parents: ["actions"],
    attributes: scope(),
    children: body,
    analyze: references(["actions"]),
  }),
  input: closed({
    parents: [...ACTION_TYPES],
    children: {
      ...children(...ATTRIBUTE_TYPES),
      "*": memberLine({}),
    },
  }),
  validate: closed({
    parents: [...ACTION_TYPES, "always"],
    children: children("check"),
  }),
  check: closed({
    parents: ["validate"],
    attributes: {
      ...named(),
      that: fn(true),
      code: text(true),
      message: text(true),
      when: fn(),
    },
  }),
  do: closed({ parents: [...ACTION_TYPES, "always"], children: steps }),
  set: closed({
    parents: ["do", "when"],
    children: {
      // `value` takes whatever was written (`&done=true`, `&status=:sent`,
      // `&title=""`, an expression); the builder requires it and type-checks it.
      "*": memberLine({ value: {} }),
    },
  }),
  when: closed({
    parents: ["do", "when"],
    attributes: { value: fn(true) },
    children: steps,
  }),
  load: closed({
    parents: ["do", "when"],
    attributes: { value: { ...members(), required: true } },
    analyze: references(["value"]),
  }),
  run: closed({ parents: ["do", "when"], attributes: { value: fn(true) } }),
  filter: closed({ parents: ["read"], attributes: { value: fn(true) } }),
  sort: closed({ parents: ["read"], children: children("asc", "desc") }),
  policies: closed({ parents: ["entity"], children: children("policy") }),
  policy: closed({
    parents: ["policies"],
    attributes: {
      ...named(),
      ...scope(),
      when: fn(),
      "authorize-if": fn(),
      "forbid-if": fn(),
    },
    children: children("authorize-if", "forbid-if"),
    analyze: references(["actions"]),
  }),
  "authorize-if": closed({
    parents: ["policy"],
    attributes: { value: fn(true) },
  }),
  "forbid-if": closed({ parents: ["policy"], attributes: { value: fn(true) } }),
};
for (const type of ATTRIBUTE_TYPES)
  contracts[type] = closed({
    parents: ["attributes", "input", "computed"],
    attributes: {
      ...named(),
      ...options(type),
      ...(["uuid", "integer", "string"].includes(type)
        ? { "primary-key": flag() }
        : {}),
      unique: flag(),
      ...(type === "timestamp"
        ? { on: { type: "atom" as const, values: ["create", "update"] } }
        : {}),
      value: fn(),
    },
    analyze(calls, ctx) {
      for (const call of calls) {
        const match = get(call, "match");
        if (match && node(match)?.type !== "RegExpLiteral")
          ctx.fail(
            "MESH_ATTRIBUTE_RULE: match must be a regular expression",
            match.loc,
          );
        const values = get(call, "values");
        if (values && node(values)?.type !== "ArrayExpression")
          ctx.fail(
            "MESH_ENUM_VALUES: values must be a list of atoms",
            values.loc,
          );
      }
    },
  });
for (const kind of ["belongs-to", "has-many", "has-one"])
  contracts[kind] = closed({
    parents: ["relationships"],
    attributes: {
      ...named(),
      entity: { type: "expression", required: true },
      ...(kind === "belongs-to" ? { nullable: flag() } : {}),
    },
    analyze(calls, ctx) {
      for (const call of calls) {
        const a = get(call, "entity");
        if (node(a)?.type !== "Identifier")
          ctx.fail(
            "MESH_ENTITY_REFERENCE: entity must be an imported identifier",
            a?.loc,
          );
      }
    },
  });
for (const kind of ACTION_TYPES)
  contracts[kind] = closed({
    parents: ["actions"],
    attributes: { ...named(), ...(kind === "read" ? { filter: fn() } : {}) },
    children: {
      input: {},
      ...body,
      ...(kind === "read" ? { filter: {}, sort: {} } : {}),
    },
  });
for (const kind of ROLLUPS)
  contracts[kind] = closed({
    parents: ["computed"],
    attributes: { ...named(), of: text(true) },
  });
for (const kind of ["asc", "desc"])
  contracts[kind] = closed({
    parents: ["sort"],
    attributes: { member: member(true) },
  });
// E1's function/array checks accept dynamic unknowns by design. This static
// dialect requires the written shape, not a runtime value of a compatible type.
for (const contract of Object.values(contracts)) {
  const analyze = contract.analyze;
  contract.analyze = (calls, ctx) => {
    for (const call of calls) {
      if (call.params.length || call.var)
        ctx.fail(
          "MESH_SYNTAX: tag parameters and variable bindings are not entity declarations",
          call.loc,
        );
      for (const [key, declaration] of Object.entries(
        contract.attributes ?? {},
      )) {
        const a = get(call, key);
        if (!a) continue;
        if (a.kind === "bound")
          ctx.fail(
            "MESH_SYNTAX: bound attributes are not entity declarations",
            a.loc,
          );
        const n = node(a);
        if (
          declaration.type === "function" &&
          !["ArrowFunctionExpression", "FunctionExpression"].includes(
            n?.type ?? "",
          )
        )
          ctx.fail(
            `MESH_EXPRESSION: ${key} must be a function as written`,
            a.loc,
          );
        if (
          key === "name" &&
          declaration.type === "atom" &&
          !(a.kind === "static" && a.atom)
        )
          ctx.fail("MESH_NAME: a declaration needs one atom name", a.loc);
        if (["auto", "types", "values"].includes(key)) {
          if (n?.type !== "ArrayExpression")
            ctx.fail(`MESH_ATOM_LIST: ${key} must be a list of atoms`, a.loc);
          const names = n?.elements?.map((e) => e?.value) ?? [];
          if (!names.length || new Set(names).size !== names.length)
            ctx.fail(
              `MESH_ATOM_LIST: ${key} must be non-empty with no repeated values`,
              a.loc,
            );
        }
        if (
          declaration.type === "string" &&
          a.kind === "static" &&
          !a.value.trim()
        )
          ctx.fail(`MESH_TEXT: ${key} cannot be empty`, a.loc);
      }
    }
    analyze?.(calls, ctx);
  };
}
export default contracts;
