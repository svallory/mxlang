/**
 * The node-type registry: one key space, `dialect:Type`, for every node the MX
 * AST can hold. Core is dialect zero (`mx`): its MX AST
 * node types are registered here with their child keys, and lowered by core
 * directly. A dialect registers its own node types (`Dialect.nodeTypes`).
 *
 * One claim process for every row: at a trigger position the parser finds the
 * matching row and asks {@link claimNode}, which calls the row's node type's
 * `parse` with the text the row matched, its span and a {@link ClaimContext}.
 * `parse` returns the node's fields, or `undefined` to decline: the text then
 * parses as if no row matched. A claimed node stays in the MX AST at its
 * position, and lowering hands it to its type's `lower`. A row naming a
 * type nothing registers is the one table error.
 *
 * Four positions: expression (an operand inside an expression), line,
 * attribute and value (an attribute's whole `=value`, once the parser knows
 * where it ends). A node claimed in expression or value position lowers to
 * an expression (or, in value position, a string); `Expr.nodes` and
 * `Attr.node` keep the node beside what it lowered to.
 */
import {
  DIALECT_HOOK_ERROR_CODE,
  INVALID_DIALECT_MODULE_CODE,
  type MxDiagnosticCode,
} from "./diagnostic-codes.ts";
import type { SourceSpan } from "./mapping.ts";
import type {
  Dialect,
  SyntaxTable,
  Trigger,
  TriggerContext,
  TriggerFailOptions,
  TriggerResult,
} from "./syntax-table.ts";

/**
 * Where a row's node type is asked to claim text: an operand inside an
 * expression, a tagless line, an attribute (the first character of its
 * name), or an attribute's whole `=value`. @unstable
 */
export type ClaimPosition = "expression" | "line" | "attribute" | "value";

/**
 * What a node type's `parse` gets besides the text and its span: where the
 * text is, and a positioned error. @unstable
 */
export interface ClaimContext {
  readonly position: ClaimPosition;
  /**
   * The static name of the tag whose attribute list holds the text, in
   * expression, attribute and value position; `null` on a tagless line, for
   * an expression outside a tag's attribute list, and for a tag whose name
   * is dynamic.
   */
  readonly tag: string | null;
  /**
   * The attribute whose value the text is, in value position; `null` for a
   * default value (`<x=value>`), and in line and attribute position.
   */
  readonly attribute: string | null;
  /**
   * A positioned error in the dialect's own words, at the text or at `at`
   * (a span inside the document), carrying `code` when given.
   */
  fail(message: string, options?: TriggerFailOptions): never;
}

/**
 * A registered node: its registry key (`"mesh:Atom"`) and the span of the
 * text it was parsed from. Core sets both; the type's `parse` returns the
 * rest. @unstable
 */
export interface DialectNode {
  readonly type: `${string}:${string}`;
  readonly span: SourceSpan;
}

/**
 * The registered node types, by key, for typing a dialect's nodes. Empty in
 * core; a dialect adds its own by declaration merging:
 *
 * ```ts
 * declare module "@mxlang/core" {
 *   interface DialectNodes { "mesh:Atom": MeshAtom }
 * }
 * ```
 * @unstable
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by dialects
export interface DialectNodes {}

/**
 * What a node type declares about its nodes (`NodeType.schema`): the fields
 * `parse` returns, and the positions the type fills. @unstable
 *
 * - `fields`: every field of the node besides `type` and `span`, by name.
 *   `"node"` holds child nodes (the names are exactly the type's `keys`),
 *   `"expression"` holds a host expression (a hole: a parsed expression, or
 *   `null` when absent), `"data"` anything else.
 * - `slot`: the positions the type fills, a non-empty list of `"expression"`
 *   (an operand inside an expression; `lower` returns its forward),
 *   `"value"` (an attribute's whole value, claimed by a value row or placed
 *   by `ctx.attribute`), `"line"` and `"attribute"`. A row naming the type
 *   at another position, and a node lowered there, are errors.
 */
export interface NodeSchema {
  readonly fields: Readonly<Record<string, "node" | "expression" | "data">>;
  readonly slot: readonly ClaimPosition[];
}

/**
 * One node type a dialect registers (`Dialect.nodeTypes`, keyed by `Type`).
 * `print(parse(text))` gives the text back. `lower` builds core's shapes with
 * the same `ctx` constructors `lowerTrigger` gets. In expression position
 * (`ctx.position === "expression"`, `ctx.use` saying how the operand is
 * used) it returns a `ctx.expression` result, the node's forward:
 * `Expr.nodes` keeps the node beside it. Core finds the node again by the
 * forward's identity, so each call returns a fresh object: a forward shared
 * by two nodes (a cached literal) is an error. In
 * value position
 * (`ctx.position === "value"`) it returns the string every target emits or
 * a `ctx.expression` result; either way the node stays on the IR (`Attr.node`
 * for a string or a string literal, else `Expr.nodes`). @unstable
 */
export interface NodeType<N extends DialectNode = DialectNode> {
  /** The fields that hold child nodes, in order; `[]` for a leaf. */
  readonly keys: readonly string[];
  /**
   * The node's own fields, from the text the row matched, or `undefined` to
   * decline the text (it then parses as if no row matched). Core adds
   * `type` and `span`, and in line and attribute position the trigger's
   * `value`, `operator` and `args`; in expression and value position the
   * node's fields are all its own but `type` and `span`.
   */
  parse(
    text: string,
    span: SourceSpan,
    ctx: ClaimContext,
  ): Omit<N, "type" | "span"> | undefined;
  /** The text the node was parsed from. */
  print(node: N): string;
  lower(node: N, ctx: TriggerContext): TriggerResult;
  /** The node's fields and the positions it fills (required). */
  readonly schema: NodeSchema;
  /**
   * The name core's messages to a file's author show for the type, in place
   * of its registry key (`label: "atom"` for `mesh:Atom`: `option mode must
   * be atom, got string`). Optional: without it the key is shown. A
   * non-empty string; registering a bad one is an invalid-dialect error.
   * Messages to the dialect's own author (registration, row and hook errors)
   * keep the key.
   */
  readonly label?: string;
}

/** One entry of the registry. */
export interface RegisteredNodeType {
  /** `dialect:Type`. */
  readonly key: string;
  readonly dialect: string;
  readonly type: string;
  readonly keys: readonly string[];
  /** A dialect's type; absent for core's own, which core lowers directly. */
  readonly nodeType?: NodeType;
  /**
   * The type's `parse`, for a type a row may name: a dialect's own, and
   * core's for `mx:Trigger`, `mx:Expression` and `mx:String`. Absent for
   * every other core type, which no row can name.
   */
  readonly parse?: NodeType["parse"];
  /** The positions a row naming the type may hold; absent means all four. */
  readonly positions?: readonly ClaimPosition[];
}

/** Core's dialect id: dialect zero. No dialect may take it. */
export const CORE_DIALECT = "mx";

/**
 * MX's own dialect declaration: plain `.mx` files are its, and where core's
 * diagnostics name the language they name it, unless the
 * file's dialect or the host names another.
 */
export const MX_DIALECT: { readonly id: string; readonly name: string } =
  Object.freeze({ id: CORE_DIALECT, name: "MX" });

/** A dialect id: lower-case words joined by `-`. */
export const DIALECT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The names core's own value types go by in a message; no label may take one. */
const CORE_TYPE_LABELS = [
  "string",
  "number",
  "boolean",
  "expression",
  "array",
  "function",
  "object",
];

/** A node type name: PascalCase. */
const TYPE_NAME = /^[A-Z][A-Za-z0-9]*$/;

/**
 * Core's MX AST node types and their child keys (`@mxlang/babel`'s
 * `mx-ast.ts`). The registry key drops the AST's `Mx` prefix
 * (`MxTag` is `mx:Tag`).
 */
const CORE_TYPES: Readonly<Record<string, readonly string[]>> = {
  Document: ["body", "errors"],
  Tag: [
    "name",
    "typeArgs",
    "var",
    "args",
    "typeParams",
    "params",
    "shorthands",
    "attributes",
    "body",
  ],
  AttributeTag: [
    "typeArgs",
    "var",
    "args",
    "typeParams",
    "params",
    "shorthands",
    "attributes",
    "body",
  ],
  Return: [
    "name",
    "typeArgs",
    "var",
    "args",
    "typeParams",
    "params",
    "shorthands",
    "attributes",
    "body",
  ],
  Attribute: ["value", "args"],
  SpreadAttribute: ["value"],
  Shorthand: ["value", "default", "args"],
  Method: ["typeParams", "params", "body"],
  Trigger: ["value", "args"],
  String: [],
  Text: [],
  Placeholder: ["expression"],
  Scriptlet: ["code"],
  ModuleStatement: ["code"],
  Comment: [],
  CDATA: [],
  Doctype: [],
  Declaration: [],
  BlockTag: [],
  Filter: [],
  ParseError: [],
  Expression: ["node", "error", "triggers"],
  Statements: ["node", "error", "triggers"],
  Pattern: ["node", "error", "triggers"],
  Arguments: ["node", "error", "triggers"],
  ParameterList: ["node", "error", "triggers"],
  TypeArguments: ["node", "error", "triggers"],
  TypeParameters: ["node", "error", "triggers"],
};

function entry(
  dialect: string,
  type: string,
  keys: readonly string[],
  nodeType?: NodeType,
  parse?: NodeType["parse"],
  positions?: readonly ClaimPosition[],
): RegisteredNodeType {
  const claims = parse ?? nodeType?.parse;
  return Object.freeze({
    key: `${dialect}:${type}`,
    dialect,
    type,
    keys: Object.freeze([...keys]),
    ...(nodeType ? { nodeType } : {}),
    ...(claims ? { parse: claims } : {}),
    ...(positions ? { positions: Object.freeze([...positions]) } : {}),
  });
}

/** The JavaScript escapes `mx:String` resolves in a quoted value. */
const STRING_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "`": "`",
  "\n": "",
};

/**
 * `mx:String`'s `parse`: a quoted value (`"a"`, `'a'`) is its contents,
 * the one-character escapes resolved; any other text is itself. A quoted
 * value with another escape (`\x41`, `\u{…}`) or a template literal is
 * declined: it parses as the expression it is, which gives the same string.
 */
export function parseMxString(text: string):
  | {
      value: string;
      raw: string;
    }
  | undefined {
  const quote = text[0];
  if (quote === "`") return undefined;
  if ((quote !== '"' && quote !== "'") || text.length < 2) {
    return { value: text, raw: text };
  }
  if (text[text.length - 1] !== quote) return undefined;
  let value = "";
  for (let i = 1; i < text.length - 1; i++) {
    const char = text[i] as string;
    if (char === quote) return undefined;
    if (char !== "\\") {
      value += char;
      continue;
    }
    const next = text[++i] as string;
    if (i >= text.length - 1) return undefined;
    // `\0` before a digit is an octal escape, which a value never means.
    if (next === "0" && /[0-9]/.test(text[i + 1] ?? "")) return undefined;
    const escaped = STRING_ESCAPES[next];
    if (escaped === undefined) return undefined;
    value += escaped;
  }
  return { value, raw: text };
}

/**
 * Core's `parse` for the types a row may name. `mx:Trigger` claims every
 * text: the node is core's `MxTrigger`, lowered by the dialect's
 * `lowerTrigger` (a `{ call }` row) or by core (the `"attribute"` row).
 * `mx:Expression` claims none: the text parses as if no row matched, which
 * is what an expression is in every position. `mx:String` claims a whole
 * attribute value as the string it spells ({@link parseMxString}).
 */
const CORE_PARSES: Readonly<Record<string, NodeType["parse"]>> = {
  Trigger: () => ({}),
  Expression: () => undefined,
  String: (text) => parseMxString(text),
};

/** The positions of core's types a row may name; absent is all four. */
const CORE_POSITIONS: Readonly<Record<string, readonly ClaimPosition[]>> = {
  Trigger: ["line", "attribute"],
  String: ["value"],
};

const CORE_REGISTRY: ReadonlyMap<string, RegisteredNodeType> = new Map(
  Object.entries(CORE_TYPES).map(([type, keys]) => {
    const registered = entry(
      CORE_DIALECT,
      type,
      keys,
      undefined,
      CORE_PARSES[type],
      CORE_POSITIONS[type],
    );
    return [registered.key, registered];
  }),
);

/** The registry key of core's trigger node (`MxTrigger`). */
export const TRIGGER_KEY = `${CORE_DIALECT}:Trigger`;

/** The registry key of core's string value node (`MxString`). */
export const STRING_KEY = `${CORE_DIALECT}:String`;

/** Registries already built, per dialect object (a dialect is fixed once loaded). */
const registries = new WeakMap<
  object,
  ReadonlyMap<string, RegisteredNodeType>
>();

/**
 * Forgets the registry built for `dialect`, so the next {@link nodeTypeRegistry}
 * reads its node types afresh. For a `dialect` option that is not
 * deep-frozen, whose node types can change between calls.
 */
export function forgetNodeTypeRegistry(dialect: object): void {
  registries.delete(dialect);
}

/**
 * The registry a file lowers with: core's node types, then the dialect's
 * (none without a dialect). The dialect is assumed valid
 * ({@link checkDialectNodeTypes} ran when it was loaded).
 */
export function nodeTypeRegistry(
  dialect?: Dialect,
): ReadonlyMap<string, RegisteredNodeType> {
  const nodeTypes = dialect?.nodeTypes;
  if (!dialect || !nodeTypes || Object.keys(nodeTypes).length === 0) {
    return CORE_REGISTRY;
  }
  const known = registries.get(dialect);
  if (known) return known;
  const registry = new Map(CORE_REGISTRY);
  for (const [type, nodeType] of Object.entries(nodeTypes)) {
    // Core places the trigger's `value` and `args` (containers) on the
    // node, so walkers reach them through `keys`.
    const registered = entry(
      dialect.id,
      type,
      [
        ...nodeType.keys,
        ...CLAIMED_KEYS.filter((key) => !nodeType.keys.includes(key)),
      ],
      nodeType as NodeType,
      undefined,
      (nodeType as NodeType).schema.slot,
    );
    registry.set(registered.key, registered);
  }
  registries.set(dialect, registry);
  return registry;
}

/**
 * Is `type` a registry key (`ref:Ref`)? A claimed node's type is its node
 * type's key; MX's own node types never hold a colon.
 */
export function isRegistryKey(type: unknown): type is string {
  return typeof type === "string" && /^[^:\s]+:[^:\s]+$/.test(type);
}

/**
 * The registry key a row's `node` names: its own for `{ type, dialect }`,
 * else core's `mx:Trigger` (a `{ call }` row, and the built-in
 * `"attribute"` spelling, are core's trigger node).
 */
export function rowKey(node: Trigger["node"]): string {
  return isNodeTypeRow(node) ? `${node.dialect}:${node.type}` : TRIGGER_KEY;
}

/**
 * A node the claim process placed in the MX AST: a registered type's node,
 * with the trigger's offsets and the `=value`, operator and arguments core
 * lexed after the row's text (the same fields `MxTrigger` has). @unstable
 */
export interface RegisteredNode extends DialectNode {
  readonly start: number;
  readonly end: number;
  readonly value: unknown;
  readonly operator: string | null;
  readonly args: unknown;
}

/** The fields core places on a claimed node that hold containers. */
const CLAIMED_KEYS = ["value", "args"] as const;

/** The fields core sets on a claimed node; a `parse` result may not hold them. */
const CORE_SET = ["type", "span", "start", "end", "value", "operator", "args"];

/** The fields core sets on a node claimed in expression or value position. */
const CORE_SET_VALUE = ["type", "span", "start", "end"];

/** Can a row naming `registered` hold `position`? */
export function claimsAt(
  registered: RegisteredNodeType | undefined,
  position: ClaimPosition | undefined,
): registered is RegisteredNodeType & { parse: NodeType["parse"] } {
  return (
    !!registered?.parse &&
    (position === undefined ||
      !registered.positions ||
      registered.positions.includes(position))
  );
}

/**
 * The claim process (one function for every position): the node type `row`
 * names parses `text` (at `span`) and returns the node's fields, or
 * `undefined` to decline. Core stamps `type` and `span` on the fields; the
 * caller places the node and sets the trigger's offsets, `value`,
 * `operator` and `args`. A row naming core's `mx:Trigger` (a `{ call }`
 * row, the `"attribute"` spelling) claims an `MxTrigger`-typed node, which
 * the parser builds as its own `MxTrigger`.
 *
 * Errors are positioned through `ctx.fail`: a type nothing registers (a
 * table the load check did not see), a `parse` that throws, and a result
 * that is not the node's own fields.
 */
export function claimNode(
  registry: ReadonlyMap<string, RegisteredNodeType>,
  row: Trigger,
  text: string,
  span: SourceSpan,
  ctx: ClaimContext,
): RegisteredNode | undefined {
  const key = rowKey(row.node);
  const registered = registry.get(key);
  if (!claimsAt(registered, ctx.position)) {
    return failWith(
      ctx,
      INVALID_DIALECT_MODULE_CODE,
      notRegisteredMessage(
        `the \`${row.id}\` trigger`,
        key,
        registry,
        ctx.position,
      ),
    );
  }
  const label = `\`parse\` (node type \`${key}\`)`;
  let fields: unknown;
  try {
    fields = registered.parse(text, span, ctx);
  } catch (error) {
    if (isTranslateErrorLike(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return failWith(
      ctx,
      DIALECT_HOOK_ERROR_CODE,
      `the \`${row.id}\` trigger's ${label} threw: ${message}`,
    );
  }
  if (fields === undefined) return undefined;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return failWith(
      ctx,
      DIALECT_HOOK_ERROR_CODE,
      `the \`${row.id}\` trigger's ${label} must return the node's fields as an object, or \`undefined\` to decline the text`,
    );
  }
  const owned = (
    ctx.position === "value" || ctx.position === "expression"
      ? CORE_SET_VALUE
      : CORE_SET
  ).filter((field) => field in fields);
  if (owned.length > 0) {
    return failWith(
      ctx,
      DIALECT_HOOK_ERROR_CODE,
      `the \`${row.id}\` trigger's ${label} returns the node's own fields: core sets ${owned.map((field) => `\`${field}\``).join(", ")}`,
    );
  }
  if (registered.nodeType) {
    const schema = registered.nodeType.schema;
    const extra = undeclaredFields(schema, fields as object, ctx.position);
    if (extra.length > 0) {
      return failWith(
        ctx,
        INVALID_DIALECT_MODULE_CODE,
        `dialect \`${registered.dialect}\`, node type \`${registered.type}\`: \`parse\` returned ${extra.map((field) => `\`${field}\``).join(", ")}, which \`schema.fields\` does not declare. Add ${extra.length === 1 ? "it" : "each"} to \`schema.fields\` (as "node", "expression" or "data"), or stop returning ${extra.length === 1 ? "it" : "them"}`,
      );
    }
    const misfit = misfitField(schema, fields as Record<string, unknown>);
    if (misfit) {
      return failWith(
        ctx,
        INVALID_DIALECT_MODULE_CODE,
        `dialect \`${registered.dialect}\`, node type \`${registered.type}\`: \`parse\` returned a \`${misfit.field}\` that is not ${misfit.want}, and \`schema.fields.${misfit.field}\` is "${misfit.kind}". Return ${misfit.want}, or declare the field "data"`,
      );
    }
  }
  const node = {
    ...(fields as object),
    type: key === TRIGGER_KEY ? "MxTrigger" : key,
    span,
  } as unknown as RegisteredNode;
  return node;
}

/**
 * Core's own error through `ctx.fail` (which positions it at the text), with
 * core's code: `ctx.fail` without one gives the dialect's default.
 */
function failWith(
  ctx: ClaimContext,
  code: MxDiagnosticCode,
  message: string,
): never {
  try {
    return ctx.fail(message);
  } catch (error) {
    if (isTranslateErrorLike(error)) {
      (error as { diagnosticCode?: string }).diagnosticCode = code;
    }
    throw error;
  }
}

/**
 * A `TranslateError` from any copy of core, by the brand `isTranslateError`
 * reads (`core.ts`, which imports this module, so it is not imported here).
 */
function isTranslateErrorLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as unknown as Record<symbol, unknown>)[
      Symbol.for("mxTranslateError")
    ] === true
  );
}

/** "`<at>` names `k`, which is not a registered node type (…)", with a note that naming another dialect's types is not supported yet. */
function notRegisteredMessage(
  at: string,
  key: string,
  registry: ReadonlyMap<string, RegisteredNodeType>,
  position?: ClaimPosition,
): string {
  const named = [...registry.values()]
    .filter((each) => claimsAt(each, position))
    .map((each) => `\`${each.key}\``);
  const dialects = new Set([...registry.values()].map((each) => each.dialect));
  const dialect = key.slice(0, key.indexOf(":"));
  const foreign = dialects.has(dialect)
    ? ""
    : `; a row names a type of core (\`${CORE_DIALECT}\`) or of its own dialect: naming another dialect's types is not supported yet`;
  // A dialect's type whose `schema.slot` leaves the position out.
  const typed = registry.get(key);
  if (position !== undefined && typed?.nodeType && typed.positions) {
    return `${at} names \`${key}\` in ${position} position, but dialect \`${typed.dialect}\`'s node type \`${typed.type}\` declares \`schema.slot\` ${JSON.stringify(typed.positions)}. Add "${position}" to its \`schema.slot\`, or move the row to a position the slot lists (${typed.positions.join(", ")})`;
  }
  // A type registered for other positions only: say which position.
  const where =
    position !== undefined && registry.get(key)?.parse
      ? ` in ${position} position`
      : "";
  const can = where ? `a row there can name` : "a row can name";
  return `${at} names \`${key}\`, which is not a registered node type${where} (${can} ${named.join(", ")})${foreign}`;
}

/** Is this row's `node` a registered node type (`{ type, dialect }`)? */
export function isNodeTypeRow(
  node: unknown,
): node is { readonly type: string; readonly dialect: string } {
  return (
    !!node &&
    typeof node === "object" &&
    typeof (node as { type?: unknown }).type === "string" &&
    typeof (node as { dialect?: unknown }).dialect === "string"
  );
}

/** Is this row's `node` a `{ call }` to the dialect's `lowerTrigger`? */
export function isCallRow(node: unknown): node is { readonly call: string } {
  return (
    !!node &&
    typeof node === "object" &&
    typeof (node as { call?: unknown }).call === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A dialect's `id`, `name` and `nodeTypes`, checked when it is loaded (a
 * loaded dialect's `id` and `name` come from its manifest). `path`
 * prefixes the field names; `fail` raises in the caller's position.
 */
export function checkDialectNodeTypes(
  value: Record<string, unknown>,
  path: string,
  fail: (message: string) => never,
): void {
  const { id, name, nodeTypes } = value;
  if (typeof id !== "string") {
    fail(
      `\`${path}id\` is required: the dialect's id, lower-case words joined by \`-\` (\`mydsl\`)`,
    );
  }
  if (!DIALECT_ID.test(id)) {
    fail(
      `\`${path}id\` must be a dialect id: lower-case words joined by \`-\` (\`mydsl\`)`,
    );
  }
  if (id === CORE_DIALECT) {
    fail(
      `\`${path}id\` cannot be \`${CORE_DIALECT}\`: that is MX's own dialect`,
    );
  }
  if (typeof name !== "string" || name.trim() === "") {
    fail(
      `\`${path}name\` is required: a non-empty string, the name tooling shows the dialect's users`,
    );
  }
  if (nodeTypes === undefined) return;
  if (!isRecord(nodeTypes)) {
    fail(
      `\`${path}nodeTypes\` must be an object of node types by name (\`{ Atom: { keys, parse, print, lower, schema } }\`)`,
    );
  }
  const types = nodeTypes as Record<string, unknown>;
  const labels = new Map<string, string>();
  for (const [type, nodeType] of Object.entries(types)) {
    const at = `${path}nodeTypes.${type}`;
    if (!TYPE_NAME.test(type)) {
      fail(`\`${at}\`: a node type name is PascalCase (\`Atom\`)`);
    }
    if (!isRecord(nodeType)) {
      fail(
        `\`${at}\` must be an object (\`{ keys, parse, print, lower, schema }\`)`,
      );
    }
    const shape = nodeType as Record<string, unknown>;
    for (const key of Object.keys(shape)) {
      if (
        !["keys", "parse", "print", "lower", "schema", "label"].includes(key)
      ) {
        fail(
          `\`${at}.${key}\` is not a node type field (keys, parse, print, lower, schema, label)`,
        );
      }
    }
    if (shape.label !== undefined) {
      const who = `dialect \`${id}\`, node type \`${type}\`: \`${at}.label\``;
      const label = shape.label;
      if (typeof label !== "string" || label.trim() === "") {
        fail(
          `${who} must be a non-empty string, the name core's messages show for the type in place of \`${id}:${type}\` (\`label: "atom"\`)`,
        );
      } else if (/[\r\n`]/.test(label) || label !== label.trim()) {
        fail(
          `${who} must be one line with no backticks and no leading or trailing space (got ${JSON.stringify(label)}): core puts it inside its messages`,
        );
      } else if (CORE_TYPE_LABELS.includes(label)) {
        fail(
          `${who} cannot be \`${label}\`: that is the name of one of core's own types, and a message would read "must be ${label}, got ${label}"`,
        );
      } else if (labels.has(label)) {
        fail(
          `${who} is \`${label}\`, which node type \`${labels.get(label)}\` of this dialect already uses: two types with one label cannot be told apart in a message`,
        );
      }
      labels.set(label as string, type);
    }
    for (const hook of ["parse", "print", "lower"] as const) {
      if (typeof shape[hook] !== "function") {
        fail(
          `dialect \`${id}\`, node type \`${type}\`: \`${at}.${hook}\` must be a function${hook === "print" ? " (the printer: it gives the text a node was parsed from)" : hook === "lower" ? " (it returns the node's forward in expression position)" : ""}`,
        );
      }
    }
    if (
      !Array.isArray(shape.keys) ||
      shape.keys.some((key) => typeof key !== "string" || key === "")
    ) {
      fail(
        `\`${at}.keys\` must be an array of the field names that hold child nodes (\`[]\` for a leaf)`,
      );
    }
    for (const key of shape.keys as string[]) {
      if (key === "type" || key === "span") {
        fail(
          `\`${at}.keys\` cannot name \`${key}\`: core sets it on every node`,
        );
      }
    }
    checkSchema(
      id,
      type,
      at,
      shape.schema,
      shape.keys as string[],
      fail,
      value.table,
    );
  }
}

/** The positions of the rows that name `dialect:type`, for the slot a message suggests. */
function slotsNamed(
  table: unknown,
  dialect: string,
  type: string,
): ClaimPosition[] {
  const found: ClaimPosition[] = [];
  if (isRecord(table)) {
    for (const [list, position] of Object.entries(ROW_LISTS)) {
      if (position === undefined || !Array.isArray(table[list])) continue;
      const names = (table[list] as unknown[]).some((row) => {
        const node = isRecord(row) ? row.node : undefined;
        return isRecord(node) && node.type === type && node.dialect === dialect;
      });
      if (names) found.push(position);
    }
  }
  return found.length > 0 ? found : ["expression"];
}

const SCHEMA_KINDS = ["node", "expression", "data"];
const SLOT_POSITIONS: readonly ClaimPosition[] = [
  "expression",
  "value",
  "line",
  "attribute",
];

/** A node type's `schema`, checked when its dialect is loaded. */
function checkSchema(
  dialect: string,
  type: string,
  at: string,
  schema: unknown,
  keys: readonly string[],
  fail: (message: string) => never,
  table?: unknown,
): void {
  const who = `dialect \`${dialect}\`, node type \`${type}\``;
  if (schema === undefined) {
    fail(
      `${who}: \`${at}.schema\` is required. Declare \`schema: { fields: { name: "data" }, slot: ${JSON.stringify(slotsNamed(table, dialect, type))} }\`: every field \`parse\` returns, as \`"node"\` (a child node, listed in \`keys\`), \`"expression"\` (a host expression) or \`"data"\`, and the positions the type fills`,
    );
  }
  if (!isRecord(schema)) {
    fail(`${who}: \`${at}.schema\` must be an object (\`{ fields, slot }\`)`);
  }
  const shape = schema as Record<string, unknown>;
  for (const key of Object.keys(shape)) {
    if (key !== "fields" && key !== "slot") {
      fail(
        `${who}: \`${at}.schema.${key}\` is not a schema field (fields, slot)`,
      );
    }
  }
  if (!isRecord(shape.fields)) {
    fail(
      `${who}: \`${at}.schema.fields\` is required: an object of the node's fields by name, each \`"node"\`, \`"expression"\` or \`"data"\` (\`{}\` for a node with none)`,
    );
  }
  const fields = shape.fields as Record<string, unknown>;
  for (const [name, kind] of Object.entries(fields)) {
    if (name === "type" || name === "span") {
      fail(
        `${who}: \`${at}.schema.fields\` cannot name \`${name}\`: core sets it on every node`,
      );
    }
    if (typeof kind !== "string" || !SCHEMA_KINDS.includes(kind)) {
      fail(
        `${who}: \`${at}.schema.fields.${name}\` must be "node", "expression" or "data"`,
      );
    }
  }
  const nodeFields = Object.keys(fields).filter(
    (name) => fields[name] === "node",
  );
  for (const key of keys) {
    if (fields[key] !== "node") {
      fail(
        `${who}: \`${at}.keys\` names \`${key}\`, so \`${at}.schema.fields.${key}\` must be "node" (it is ${fields[key] === undefined ? "not declared" : JSON.stringify(fields[key])})`,
      );
    }
  }
  for (const name of nodeFields) {
    if (!keys.includes(name)) {
      fail(
        `${who}: \`${at}.schema.fields.${name}\` is "node", so \`${at}.keys\` must list \`${name}\` (the fields that hold child nodes); or declare it "expression" or "data"`,
      );
    }
  }
  const slot = shape.slot;
  if (
    !Array.isArray(slot) ||
    slot.length === 0 ||
    slot.some((each) => !SLOT_POSITIONS.includes(each as ClaimPosition)) ||
    new Set(slot).size !== slot.length
  ) {
    fail(
      `${who}: \`${at}.schema.slot\` must be a non-empty list of the positions the type fills, each of "expression", "value", "line", "attribute" once (\`["expression", "value"]\`)`,
    );
  }
}

/**
 * The fields of `node` that its type's `schema` does not declare (besides
 * the ones core sets), in order.
 */
export function undeclaredFields(
  schema: NodeSchema,
  node: object,
  position: ClaimPosition,
): string[] {
  const set =
    position === "value" || position === "expression"
      ? CORE_SET_VALUE
      : CORE_SET;
  return Object.keys(node).filter(
    (field) => !set.includes(field) && !(field in schema.fields),
  );
}

/**
 * The first field of `node` that does not fit its declared kind: an
 * `"expression"` field holds a parsed expression (an object with a string
 * `type`) or `null`; a `"node"` field a node, a list of nodes, or `null`.
 * Fields a node does not carry are not checked.
 */
export function misfitField(
  schema: NodeSchema,
  node: Record<string, unknown>,
): { field: string; kind: "node" | "expression"; want: string } | undefined {
  for (const [field, kind] of Object.entries(schema.fields)) {
    const value = node[field];
    if (kind === "data" || value === undefined || value === null) continue;
    const isNode = (each: unknown) =>
      !!each &&
      typeof each === "object" &&
      typeof (each as { type?: unknown }).type === "string";
    if (kind === "expression" && !isNode(value)) {
      return {
        field,
        kind,
        want: "a parsed host expression (a node with a `type`) or `null`",
      };
    }
    if (
      kind === "node" &&
      !(Array.isArray(value) ? value.every(isNode) : isNode(value))
    ) {
      return { field, kind, want: "a node, a list of nodes or `null`" };
    }
  }
  return undefined;
}

/** The trigger lists a table holds rows in, with the position each takes. */
const ROW_LISTS = {
  expressionTriggers: "expression",
  attributeTriggers: "attribute",
  lineTriggers: "line",
  valueTriggers: "value",
  textTriggers: undefined,
} as const satisfies Record<string, ClaimPosition | undefined>;

/**
 * The first row of `table` naming a node type that is not registered for
 * its position (core's `mx:Trigger` and `mx:Expression`, `mx:String` in
 * value position, or one of the dialect's `nodeTypes`), as an error
 * message, or `undefined`. `path` names the table (`table`,
 * `dialect.table`) in the message.
 */
export function unregisteredNodeRow(
  table: SyntaxTable,
  dialect: Dialect | undefined,
  path: string,
): string | undefined {
  const registry = nodeTypeRegistry(dialect);
  for (const [list, position] of Object.entries(ROW_LISTS) as [
    keyof typeof ROW_LISTS,
    ClaimPosition | undefined,
  ][]) {
    for (const [index, row] of (table[list] ?? []).entries()) {
      const node: unknown = row.node;
      if (!isNodeTypeRow(node)) continue;
      const key = `${node.dialect}:${node.type}`;
      if (claimsAt(registry.get(key), position)) continue;
      return notRegisteredMessage(
        `\`${path}.${list}[${index}].node\` (trigger "${row.id}")`,
        key,
        registry,
        position,
      );
    }
  }
  return undefined;
}
