/**
 * The node-type registry (decision 202 item 3): one key space, `dialect:Type`,
 * for every node the MX AST can hold. Core is dialect zero (`mx`): its MX AST
 * node types are registered here with their child keys, and lowered by core
 * directly. A dialect registers its own node types (`Dialect.nodeTypes`);
 * a syntax table row names one with `node: { type, dialect }`, the row's
 * `match` decides where the node ends, and lowering hands the node's text to
 * the type's `parse`, then the node to its `lower`.
 *
 * Tag and attribute position only (attribute and line triggers): an
 * expression-position row naming a node type is a table error until
 * expression-position node types land.
 */
import type { SourceSpan } from "./mapping.ts";
import type {
  Dialect,
  SyntaxTable,
  TriggerContext,
  TriggerFailOptions,
  TriggerResult,
} from "./syntax-table.ts";

/** What a node type's `parse` gets besides the text: a positioned error. @unstable */
export interface NodeKit {
  /**
   * A positioned error in the dialect's own words, at the node's text or at
   * `at` (a span inside the document), carrying `code` when given.
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
  /** The node's own fields, from the text the row matched; core adds `type` and `span`. */
  parse(text: string, span: SourceSpan, kit: NodeKit): Omit<N, "type" | "span">;
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
): RegisteredNodeType {
  return Object.freeze({
    key: `${dialect}:${type}`,
    dialect,
    type,
    keys: Object.freeze([...keys]),
    ...(nodeType ? { nodeType } : {}),
  });
}

const CORE_REGISTRY: ReadonlyMap<string, RegisteredNodeType> = new Map(
  Object.entries(CORE_TYPES).map(([type, keys]) => {
    const registered = entry(CORE_DIALECT, type, keys);
    return [registered.key, registered];
  }),
);

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
    const registered = entry(
      dialect.id,
      type,
      nodeType.keys,
      nodeType as NodeType,
    );
    registry.set(registered.key, registered);
  }
  registries.set(dialect, registry);
  return registry;
}

/** The registered type a `{ type, dialect }` row names, or `undefined`. */
export function registeredNodeType(
  dialect: Dialect | undefined,
  node: { readonly type: string; readonly dialect: string },
): RegisteredNodeType | undefined {
  return nodeTypeRegistry(dialect).get(`${node.dialect}:${node.type}`);
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
 * The first row of `table` naming a node type the dialect does not
 * register, as an error message, or `undefined`. `path` names the table
 * (`table`, `dialect.table`) in the message.
 */
export function unregisteredNodeRow(
  table: SyntaxTable,
  dialect: Dialect | undefined,
  path: string,
): string | undefined {
  for (const list of ROW_LISTS) {
    for (const [index, row] of table[list].entries()) {
      const node: unknown = row.node;
      if (!isNodeTypeRow(node)) continue;
      const at = `\`${path}.${list}[${index}].node\` (trigger "${row.id}")`;
      if (node.dialect === CORE_DIALECT) {
        return `${at} names \`${CORE_DIALECT}:${node.type}\`: core's own node types are not trigger targets; name one of the dialect's`;
      }
      if (!dialect) {
        return `${at} names \`${node.dialect}:${node.type}\`, and no dialect registers node types here: a table naming a node type comes from a dialect with \`nodeTypes\``;
      }
      if (node.dialect !== dialect.id) {
        return `${at} names the dialect \`${node.dialect}\`, and this dialect is \`${dialect.id}\`: a row names a node type of its own dialect`;
      }
      if (!registeredNodeType(dialect, node)) {
        const known = Object.keys(dialect.nodeTypes ?? {});
        return `${at} names \`${node.dialect}:${node.type}\`, which the dialect does not register (${known.length === 0 ? "it registers none" : `it registers ${known.join(", ")}`})`;
      }
    }
  }
  return undefined;
}
