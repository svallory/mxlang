/**
 * The node-type registry (decision 202 item 3): one key space, `dialect:Type`,
 * for every node the MX AST can hold. Core is dialect zero (`mx`): its MX AST
 * node types are registered here with their child keys, and lowered by core
 * directly. A dialect registers its own node types (`Dialect.nodeTypes`).
 *
 * One claim process for every row (decision 202 item 3, the claim ruling):
 * at a trigger position the parser finds the matching row and asks
 * {@link claimNode}, which calls the row's node type's `parse` with the
 * text the row matched, its span and a {@link ClaimContext}. `parse`
 * returns the node's fields, or `undefined` to decline: the text then
 * parses as if no row matched. A claimed node stays in the MX AST at its
 * position, and lowering hands it to its type's `lower`. A row naming a
 * type nothing registers is the one table error.
 *
 * Attribute and line position only: an expression-position row naming a
 * node type is a table error (expression-position rows stay `{ call }`,
 * `"string"` or `"identifier"`).
 */
import type { SourceSpan } from "./mapping.ts";
import type {
  Dialect,
  SyntaxTable,
  Trigger,
  TriggerContext,
  TriggerFailOptions,
  TriggerResult,
} from "./syntax-table.ts";

/** Where a row's node type is asked to claim text. @unstable */
export type ClaimPosition = "line" | "attribute";

/**
 * What a node type's `parse` gets besides the text and its span: where the
 * text is, and a positioned error. @unstable
 */
export interface ClaimContext {
  readonly position: ClaimPosition;
  /**
   * The static name of the tag whose attribute list holds the text, in
   * attribute position; `null` on a tagless line, and for a tag whose name
   * is dynamic.
   */
  readonly tag: string | null;
  /** The attribute whose value holds the text; `null` in line and attribute position. */
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
 * One node type a dialect registers (`Dialect.nodeTypes`, keyed by `Type`).
 * `print(parse(text))` gives the text back. `lower` builds core's shapes with
 * the same `ctx` constructors `lowerTrigger` gets; a whole attribute value
 * keeps the node (`ctx.attribute(name, { kind: "node", node, value })`), so
 * the IR carries it beside the static value every target emits. @unstable
 */
export interface NodeType<N extends DialectNode = DialectNode> {
  /** The fields that hold child nodes, in order; `[]` for a leaf. */
  readonly keys: readonly string[];
  /**
   * The node's own fields, from the text the row matched, or `undefined` to
   * decline the text (it then parses as if no row matched). Core adds
   * `type` and `span`, and the trigger's `value`, `operator` and `args`.
   */
  parse(
    text: string,
    span: SourceSpan,
    ctx: ClaimContext,
  ): Omit<N, "type" | "span"> | undefined;
  /** The text the node was parsed from. */
  print(node: N): string;
  lower(node: N, ctx: TriggerContext): TriggerResult;
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
   * core's for `mx:Trigger` and `mx:Expression`. Absent for every other
   * core type, which no row can name.
   */
  readonly parse?: NodeType["parse"];
}

/** Core's dialect id: dialect zero. No dialect may take it. */
export const CORE_DIALECT = "mx";

/**
 * MX's own dialect declaration (decision 212): plain `.mx` files are its,
 * and where core's diagnostics name the language they name it, unless the
 * file's dialect or the host names another.
 */
export const MX_DIALECT: { readonly id: string; readonly name: string } =
  Object.freeze({ id: CORE_DIALECT, name: "MX" });

/** A dialect id: lower-case words joined by `-`. */
export const DIALECT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

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
  Atom: [],
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
  Expression: ["node", "error", "atoms", "triggers"],
  Statements: ["node", "error", "atoms", "triggers"],
  Pattern: ["node", "error", "atoms", "triggers"],
  Arguments: ["node", "error", "atoms", "triggers"],
  ParameterList: ["node", "error", "atoms", "triggers"],
  TypeArguments: ["node", "error", "atoms", "triggers"],
  TypeParameters: ["node", "error", "atoms", "triggers"],
};

function entry(
  dialect: string,
  type: string,
  keys: readonly string[],
  nodeType?: NodeType,
  parse?: NodeType["parse"],
): RegisteredNodeType {
  const claims = parse ?? nodeType?.parse;
  return Object.freeze({
    key: `${dialect}:${type}`,
    dialect,
    type,
    keys: Object.freeze([...keys]),
    ...(nodeType ? { nodeType } : {}),
    ...(claims ? { parse: claims } : {}),
  });
}

/**
 * Core's `parse` for the types a row may name. `mx:Trigger` claims every
 * text: the node is core's `MxTrigger`, lowered by the dialect's
 * `lowerTrigger` (a `{ call }` row) or by core (the `"attribute"` row).
 * `mx:Expression` claims none in attribute or line position: the text
 * parses as if no row matched, which is what an expression is there.
 */
const CORE_PARSES: Readonly<Record<string, NodeType["parse"]>> = {
  Trigger: () => ({}),
  Expression: () => undefined,
};

const CORE_REGISTRY: ReadonlyMap<string, RegisteredNodeType> = new Map(
  Object.entries(CORE_TYPES).map(([type, keys]) => {
    const registered = entry(
      CORE_DIALECT,
      type,
      keys,
      undefined,
      CORE_PARSES[type],
    );
    return [registered.key, registered];
  }),
);

/** The registry key of core's trigger node (`MxTrigger`). */
export const TRIGGER_KEY = `${CORE_DIALECT}:Trigger`;

/** Registries already built, per dialect object (a dialect is fixed once loaded). */
const registries = new WeakMap<
  object,
  ReadonlyMap<string, RegisteredNodeType>
>();

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
    );
    registry.set(registered.key, registered);
  }
  registries.set(dialect, registry);
  return registry;
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
  if (!registered?.parse) {
    return ctx.fail(
      notRegisteredMessage(`the \`${row.id}\` trigger`, key, registry),
    );
  }
  const label = `\`parse\` (node type \`${key}\`)`;
  let fields: unknown;
  try {
    fields = registered.parse(text, span, ctx);
  } catch (error) {
    if (isTranslateErrorLike(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return ctx.fail(`the \`${row.id}\` trigger's ${label} threw: ${message}`);
  }
  if (fields === undefined) return undefined;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return ctx.fail(
      `the \`${row.id}\` trigger's ${label} must return the node's fields as an object, or \`undefined\` to decline the text`,
    );
  }
  const owned = CORE_SET.filter((field) => field in fields);
  if (owned.length > 0) {
    return ctx.fail(
      `the \`${row.id}\` trigger's ${label} returns the node's own fields: core sets ${owned.map((field) => `\`${field}\``).join(", ")}`,
    );
  }
  const node = {
    ...(fields as object),
    type: key === TRIGGER_KEY ? "MxTrigger" : key,
    span,
  } as unknown as RegisteredNode;
  return node;
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
): string {
  const named = [...registry.values()]
    .filter((each) => each.parse)
    .map((each) => `\`${each.key}\``);
  const dialects = new Set([...registry.values()].map((each) => each.dialect));
  const dialect = key.slice(0, key.indexOf(":"));
  const foreign = dialects.has(dialect)
    ? ""
    : `; a row names a type of core (\`${CORE_DIALECT}\`) or of its own dialect: naming another dialect's types is not supported yet`;
  return `${at} names \`${key}\`, which is not a registered node type (a row can name ${named.join(", ")})${foreign}`;
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
      `\`${path}id\` is required: the dialect's id, lower-case words joined by \`-\` (\`mesh\`)`,
    );
  }
  if (!DIALECT_ID.test(id)) {
    fail(
      `\`${path}id\` must be a dialect id: lower-case words joined by \`-\` (\`mesh\`)`,
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
      `\`${path}nodeTypes\` must be an object of node types by name (\`{ Atom: { keys, parse, print, lower } }\`)`,
    );
  }
  const types = nodeTypes as Record<string, unknown>;
  for (const [type, nodeType] of Object.entries(types)) {
    const at = `${path}nodeTypes.${type}`;
    if (!TYPE_NAME.test(type)) {
      fail(`\`${at}\`: a node type name is PascalCase (\`Atom\`)`);
    }
    if (!isRecord(nodeType)) {
      fail(`\`${at}\` must be an object (\`{ keys, parse, print, lower }\`)`);
    }
    const shape = nodeType as Record<string, unknown>;
    for (const key of Object.keys(shape)) {
      if (!["keys", "parse", "print", "lower"].includes(key)) {
        fail(
          `\`${at}.${key}\` is not a node type field (keys, parse, print, lower)`,
        );
      }
    }
    for (const hook of ["parse", "print", "lower"] as const) {
      if (typeof shape[hook] !== "function") {
        fail(`\`${at}.${hook}\` must be a function`);
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
  }
}

/** The trigger lists a table holds rows in, with the positions each takes. */
const ROW_LISTS = [
  "expressionTriggers",
  "attributeTriggers",
  "lineTriggers",
  "textTriggers",
] as const;

/**
 * The first row of `table` naming a node type that is not registered (core's
 * `mx:Trigger` and `mx:Expression`, or one of the dialect's `nodeTypes`), as
 * an error message, or `undefined`. `path` names the table (`table`,
 * `dialect.table`) in the message.
 */
export function unregisteredNodeRow(
  table: SyntaxTable,
  dialect: Dialect | undefined,
  path: string,
): string | undefined {
  const registry = nodeTypeRegistry(dialect);
  for (const list of ROW_LISTS) {
    for (const [index, row] of table[list].entries()) {
      const node: unknown = row.node;
      if (!isNodeTypeRow(node)) continue;
      const key = `${node.dialect}:${node.type}`;
      if (registry.get(key)?.parse) continue;
      return notRegisteredMessage(
        `\`${path}.${list}[${index}].node\` (trigger "${row.id}")`,
        key,
        registry,
      );
    }
  }
  return undefined;
}
