/**
 * Layer-2 trigger lowering (decision 182 addendum 5): what a syntax table's
 * triggers become before anything reads the tree.
 *
 * The parser already ran the claim process (`claimNode`): an attribute or
 * line trigger's node is in the tree at its position, typed by its
 * registry key: core's `MxTrigger` (a `{ call }` row, the `"attribute"`
 * spelling, a row naming `mx:Trigger`) or a dialect's own type
 * (`ref:Ref`). Lowering dispatches on `node.type`.
 *
 * One pass per document, run by `lower`/`lowerChildren` right after the atom
 * conversion, lowers every trigger node once, in source order (a value's
 * own triggers before the trigger that owns it), through its hook: the
 * dialect's `lowerTrigger` for core's `MxTrigger`, a dialect type's own
 * `lower` for its node; the built-in node kinds resolve without a hook:
 *
 * - an expression trigger's stand-in is replaced, inside its container's
 *   payload, by the node `ctx.expression(node)` carries (or the built-in
 *   string literal / identifier); the container's authored `source` and
 *   every offset stay as written;
 * - an attribute trigger node lowers to ordinary `MxAttribute`s, which
 *   `attributesWithTriggers` puts in its place when `tagAttributesOf` reads
 *   the list;
 * - a line trigger node lowers to an ordinary `MxTag` (`ctx.child`), which
 *   `childrenWithTriggers` puts in its place when `bodyChildren` and the
 *   root walk read the body, so the tag goes through the normal tag path
 *   (contracts and declarations apply).
 *
 * Each node's lowering is kept per node, so a second walk (a scratch `Ctx`)
 * calls no hook twice; the tree stays as parsed. A trigger this pass never
 * reached (a document lowered with no registered syntax, a `{ call }` with
 * no `lowerTrigger`) is refused at the seams (`payloadOf`, `lowerChildList`,
 * the attribute list) with "has no lowering yet".
 */
import { coreBabel } from "./babel.ts";
import {
  type Ctx,
  fail,
  isTranslateError,
  type Node,
  positionAtOffset,
} from "./core.ts";
import { raiseDeferredContractErrors } from "./custom-tags.ts";
import {
  isCallRow,
  isNodeTypeRow,
  nodeTypeRegistry,
  type RegisteredNode,
  rowKey,
  TRIGGER_KEY,
} from "./dialect-registry.ts";
import type { Member, MxMemberMark } from "./ir.ts";
import { loweredUnitOf } from "./lowered-unit.ts";
import type { SourceSpan } from "./mapping.ts";
import type {
  Dialect,
  ResolvedSyntax,
  SyntaxTable,
  Trigger,
  TriggerAttribute,
  TriggerAttributeOptions,
  TriggerAttributeValue,
  TriggerChild,
  TriggerContext,
  TriggerExpression,
  TriggerFailOptions,
  TriggerMethod,
  TriggerPosition,
  TriggerResult,
  TriggerShorthand,
  TriggerUse,
  TriggerValueForm,
} from "./syntax-table.ts";

/** The member a whole-value `StringLiteral` stands for (`extra.mxMember`), or `undefined`. */
export function memberOf(node: Node): Member | undefined {
  const mark: MxMemberMark | undefined = node?.extra?.mxMember;
  if (node?.type !== "StringLiteral" || !mark) return undefined;
  return { kind: "member", name: mark.name, span: mark.span };
}

/** The trigger lists, by their `MxTrigger.position`. */
const TRIGGER_LISTS = {
  expression: "expressionTriggers",
  attribute: "attributeTriggers",
  line: "lineTriggers",
} as const;

/**
 * The table row an `MxTrigger` came from: its id in the list its position
 * names. Here, not in `syntax-table.ts`, so lowering's import graph never
 * reaches the parser front end (core's sources load under Node's
 * strip-only mode, which the front end's sources do not).
 */
export function triggerRow(
  table: SyntaxTable,
  trigger: { id: string; position: TriggerPosition },
): Trigger | undefined {
  return table[TRIGGER_LISTS[trigger.position]].find(
    (row) => row.id === trigger.id,
  );
}

/** A document's syntax, by every body array it holds (so a host lowering a nested body finds it). */
const syntaxRuns = new WeakMap<readonly unknown[], SyntaxRun>();

/**
 * A registered document's syntax and the text each lowered trigger prints
 * as: `expr()` splices it into an expression's `code` (`&status` becomes
 * `self.status`), as it splices atoms. Per document, not per `Ctx`, so a
 * scratch walk (`analyze`) and the real one share it.
 */
interface SyntaxRun {
  readonly syntax: ResolvedSyntax;
  readonly splices: { start: number; end: number; text: string }[];
}

/**
 * Records a parsed document's syntax for lowering. The default row records
 * nothing: a plain project pays one comparison.
 */
export function registerSyntax(document: Node, syntax: ResolvedSyntax): void {
  if (syntax.isDefault) return;
  const run: SyntaxRun = { syntax, splices: [] };
  const seen = new Set<unknown>();
  const visit = (value: Node): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value.type !== "string") return;
    if (Array.isArray(value.body)) {
      syntaxRuns.set(value.body, run);
      visit(value.body);
    }
  };
  syntaxRuns.set(document.body, run);
  visit(document.body);
}

/** Triggers this pass lowered; `payloadOf` and the seams skip them. */
const lowered = new WeakSet<object>();

/** Has the trigger pass lowered this `MxTrigger`? */
export function isTriggerLowered(trigger: Node): boolean {
  return lowered.has(trigger);
}

/**
 * Is `type` a registry key (`ref:Ref`)? A claimed node's type is its node
 * type's key; MX's own node types never hold a colon. The node is lowered
 * through the registry by this key, which refuses a key nothing registers.
 */
function isRegisteredKey(type: unknown): boolean {
  return typeof type === "string" && /^[^:\s]+:[^:\s]+$/.test(type);
}

/**
 * Is `node` a trigger node of the tree: core's `MxTrigger`, or a node a
 * registered type claimed? Read from `node.type` alone.
 */
function isTriggerNode(node: Node): boolean {
  return node?.type === "MxTrigger" || isRegisteredKey(node?.type);
}

/**
 * The row a claimed node came from: the first row of `position` naming the
 * node's type whose `chars` and `match` take `text` (the parser asks rows in
 * that order).
 */
function claimedRow(
  table: SyntaxTable,
  position: "attribute" | "line",
  type: string,
  text: string,
): Trigger | undefined {
  const rows = table[TRIGGER_LISTS[position]].filter(
    (row) => isNodeTypeRow(row.node) && rowKey(row.node) === type,
  );
  if (rows.length <= 1) return rows[0];
  return (
    rows.find((row) => {
      if (!row.chars.includes(text.charAt(0))) return false;
      try {
        return new RegExp(`^(?:${row.match})$`).test(text);
      } catch {
        return false;
      }
    }) ?? rows[0]
  );
}

/**
 * A trigger node as lowering reads it: an `MxTrigger` as is; a claimed node
 * as an `MxTrigger` view rebuilt from the node and the table: the row naming
 * its type at `position`, the text its `span` covers, its offsets, `value`,
 * `operator` and `args`, and the node itself (`claimed`). Errors about the
 * node are positioned on the view.
 */
function triggerOf(
  ctx: Ctx,
  table: SyntaxTable,
  node: Node,
  position: "attribute" | "line",
): Node {
  if (node?.type === "MxTrigger") return node;
  const span = node.span ?? { sourceStart: node.start, sourceEnd: node.end };
  const text = ctx.source.slice(span.sourceStart, span.sourceEnd);
  return {
    type: "MxTrigger",
    start: node.start,
    end: node.end,
    id: claimedRow(table, position, node.type, text)?.id ?? node.type,
    position,
    text,
    operator: node.operator ?? null,
    value: node.value ?? null,
    args: node.args ?? null,
    claimed: node,
  };
}

/**
 * The lowering cache: what each line or attribute trigger node lowered to
 * (an `MxTag` for a line; attributes and shorthands for an attribute),
 * keyed by the AST node. It is filled by one pass (`lowerTriggers`, which
 * dispatches on `node.type`), once per node, in source order, before
 * `afterLower`; the walkers below only read it. It is never consulted to
 * decide what a node is, and holds nothing the node and the table cannot
 * rebuild. Plan: lowering inside the walkers, with the `Ctx`, replaces it.
 */
const loweredNodes = new WeakMap<object, Node | Node[]>();

/** A claimed node the pass never lowered: an internal bug, never a fallback. */
function notLowered(node: Node): never {
  throw new Error(
    `internal: the \`${node.type}\` node at ${node.start} was read before the trigger pass lowered it`,
  );
}

/**
 * A tag's attributes as authored, each attribute trigger node replaced by
 * what it lowered to (the name-sugar pass reads these). An `MxTrigger` the
 * pass never lowered stays, for the seams to refuse; a claimed node the pass
 * never lowered is an internal error.
 */
export function attributesWithTriggers(tag: Node): Node[] {
  const attributes: Node[] = tag?.attributes ?? [];
  if (!attributes.some(isTriggerNode)) return attributes;
  return attributes.flatMap((attr) => {
    if (!isTriggerNode(attr)) return [attr];
    const results = loweredNodes.get(attr) as Node[] | undefined;
    if (results) return results;
    return attr.type === "MxTrigger" ? [attr] : notLowered(attr);
  });
}

/**
 * A body's children, each line trigger node replaced by the tag it lowered
 * to. An `MxTrigger` the pass never lowered stays, for the seam in
 * `lowerChildList` to refuse; a claimed node the pass never lowered is an
 * internal error.
 */
export function childrenWithTriggers<T>(children: readonly T[]): T[] {
  if (!children.some((child) => isTriggerNode(child as Node))) {
    return children as T[];
  }
  return children.map((child) => {
    const node = child as Node;
    if (!isTriggerNode(node)) return child;
    const result = loweredNodes.get(node) as Node | undefined;
    if (result) return result as T;
    return (node.type === "MxTrigger" ? child : notLowered(node)) as T;
  });
}

/** Results built by a `TriggerContext`, so a hand-made object is refused. */
const built = new WeakSet<object>();

/** The `MxExpression` container behind an expression result. */
const containers = new WeakMap<object, Node>();

/** Lowered once per `Ctx`: the dialect's `afterLower` and `name`. */
const applied = new WeakSet<Ctx>();

/**
 * Lowers every trigger under `roots` (see the file header). Idempotent: a
 * trigger already lowered is skipped, so a second walk (a scratch `Ctx`)
 * calls no hook twice.
 */
export function lowerTriggers(ctx: Ctx, roots: readonly Node[]): boolean {
  const run = syntaxRuns.get(roots);
  if (!run) return false;
  const { table, dialect } = run.syntax;
  ctx.triggerSplices = run.splices;
  ctx.dialect = dialect;
  if (dialect && !applied.has(ctx)) {
    applied.add(ctx);
    const afterLower = dialect.afterLower;
    if (afterLower) {
      // The dialect sees the unit through its public view, never the `Ctx`.
      ctx.afterLower = [
        ...(ctx.afterLower ?? []),
        (unit) => afterLower(loweredUnitOf(unit)),
      ];
    }
    if (dialect.contractFields) {
      // Core's own errors on claimed keys, behind the dialect's hook.
      ctx.afterLower = [...(ctx.afterLower ?? []), raiseDeferredContractErrors];
    }
    // The dialect names the language in core's diagnostics (decision 212
    // item 10), unless the host set a product name itself.
    if (ctx.productName === undefined) ctx.productName = dialect.name;
  }
  const seen = new WeakSet<object>();
  // `owner` is the node holding `value` (arrays pass it through): a
  // container's owner tells a spread (`<div ...x/>`) from other uses.
  const visit = (value: Node, owner: Node | null): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      // A body's line trigger nodes are lowered as the walk reaches them, so
      // every hook runs in source order; an attribute list is lowered by
      // `mapAttributes`, never as a body.
      const body = owner?.attributes !== value;
      for (const item of value) {
        visit(item, owner);
        if (body) lowerChild(ctx, table, dialect, item);
      }
      return;
    }
    if (typeof value.type !== "string") {
      // A typeless MX field shape (a dynamic tag name's `{ kind, expression }`,
      // a shorthand's value) holds containers too; it is no owner itself.
      for (const [key, child] of Object.entries(value)) {
        if (key === "span" || !child || typeof child !== "object") continue;
        visit(child, owner);
      }
      return;
    }
    if (isContainer(value)) {
      lowerExpressionTriggers(ctx, run, value, owner);
      return;
    }
    // A dialect type's node: only the trigger's value and arguments, which
    // core lexed, hold containers; its own fields are the dialect's.
    if (value.type !== "MxTrigger" && isTriggerNode(value)) {
      visit(value.value, value);
      visit(value.args, value);
      return;
    }
    // A tag's attributes before its body, in source order.
    if (Array.isArray(value.attributes)) {
      visit(value.attributes, value);
      mapAttributes(ctx, table, dialect, value);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "loc" || !child || typeof child !== "object") continue;
      visit(child, value);
    }
  };
  visit(roots, null);
  return true;
}

/** An MX expression container (`MxExpression`, `MxStatements`, …; ast §4.1). */
function isContainer(node: Node): boolean {
  return (
    typeof node.type === "string" &&
    node.type.startsWith("Mx") &&
    "outer" in node &&
    "node" in node
  );
}

function spanRange(trigger: Node): { start: number; end: number } {
  const span = spanOf(trigger);
  return { start: span.sourceStart, end: span.sourceEnd };
}

/**
 * Where an attribute trigger's text starts, when `async` is written before
 * it (`async :x(p) { b }`): the trigger's span starts at `async`, its text
 * after it. Recorded by `lowerAttributeTrigger` from the source.
 */
const asyncTextStart = new WeakMap<Node, number>();

/** The trigger's own text (`:x` in `async :x(p) { b }`), never the `async` before it. */
function spanOf(trigger: Node): SourceSpan {
  const start = asyncTextStart.get(trigger) ?? trigger.start;
  return {
    sourceStart: start,
    sourceEnd: start + String(trigger.text).length,
  };
}

/** `a`/`an` and the backticked name: "an `Identifier`", "a `MemberExpression`". */
function named(type: string): string {
  return `${/^[aeiou]/i.test(type) ? "an" : "a"} \`${type}\``;
}

/** What a non-node value is, for a message: "`undefined`", "a string", "an object with no `type`". */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return `\`${value}\``;
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object with no `type`";
  return named(typeof value).replace(/`/g, "");
}

/**
 * Why `value` is not a Babel expression node core can place and print, or
 * `undefined` when it is one: an expression type, every field valid by
 * Babel's own validators, all the way down. A field Babel defaults
 * (`computed: false`) may be left out, as its builders allow; a required
 * one (`Identifier.name`) may not.
 */
function notAnExpression(value: unknown): string | undefined {
  const t = coreBabel().types;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return describeValue(value);
  }
  const type = (value as Node).type;
  if (typeof type !== "string") return describeValue(value);
  if (!t.isExpression(value)) return named(type);
  const seen = new Set<object>();
  const check = (node: Node): string | undefined => {
    if (seen.has(node)) return undefined;
    seen.add(node);
    const fields: Record<string, { default?: unknown }> | undefined =
      t.NODE_FIELDS[node.type];
    if (!fields) return `${named(node.type)}, which is not a Babel node type`;
    for (const [key, field] of Object.entries(fields)) {
      const fieldValue = node[key];
      if (fieldValue === undefined && field.default != null) continue;
      try {
        t.validate(node, key, fieldValue);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `${named(node.type)} whose \`${key}\` is invalid (${message})`;
      }
      for (const child of Array.isArray(fieldValue)
        ? fieldValue
        : [fieldValue]) {
        if (
          child &&
          typeof child === "object" &&
          typeof child.type === "string"
        ) {
          const problem = check(child);
          if (problem) return problem;
        }
      }
    }
    return undefined;
  };
  return check(value as Node);
}

/**
 * The printed text of a trigger's replacement, for the `code` splice. A
 * node that passed `notAnExpression` prints; a printer failure still leaves
 * positioned at the trigger, never as an unpositioned internal error.
 */
function printed(ctx: Ctx, node: Node, trigger: Node): string {
  try {
    return ctx.generate(node);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(
      `the \`${trigger.id}\` trigger's replacement does not print: ${message}`,
      trigger,
    );
  }
}

/** The positioned error for a hook's result that does not fit its position. */
function wrongResult(trigger: Node, want: string): never {
  return fail(
    `the \`${trigger.id}\` trigger's ${hookLabel(trigger)} must return \`${want}\` for a trigger in ${positionPhrase(trigger.position)}`,
    trigger,
  );
}

/**
 * The hook a trigger lowers through, as its errors name it: the dialect's
 * `lowerTrigger` for a `{ call }` row, a node type's `lower` for a
 * `{ type, dialect }` row.
 */
interface TriggerHook {
  readonly label: string;
  call(context: TriggerContext): TriggerResult;
}

/** The label of the hook each trigger lowers through, when it is not `lowerTrigger`. */
const hookLabels = new WeakMap<Node, string>();

function hookLabel(trigger: Node): string {
  return hookLabels.get(trigger) ?? "`lowerTrigger`";
}

/** The dialect's `lowerTrigger` as a trigger's hook; "has no lowering yet" without one. */
function lowerTriggerHook(
  dialect: Dialect | undefined,
  trigger: Node,
): TriggerHook {
  const lowerTrigger = dialect?.lowerTrigger;
  if (!lowerTrigger) noLowering(trigger);
  return {
    label: "`lowerTrigger`",
    call: (context) =>
      (lowerTrigger as NonNullable<Dialect["lowerTrigger"]>)(
        trigger.id,
        trigger.text,
        spanOf(trigger),
        context,
      ),
  };
}

/**
 * The node type a dialect's node was claimed by, as the trigger's hook: its
 * `lower` builds the node the parser placed (`claimNode` parsed and
 * stamped it). An `MxTrigger` a node-type row left (a document parsed
 * without the claim process) has no lowering.
 */
function nodeTypeHook(
  dialect: Dialect | undefined,
  trigger: Node,
  node: RegisteredNode,
): TriggerHook {
  // Dispatch on the node's own type: the type that parsed it lowers it.
  const registered = nodeTypeRegistry(dialect).get(node.type);
  const nodeType = registered?.nodeType;
  if (!registered || !nodeType) return noLowering(trigger);
  const label = `\`lower\` (node type \`${registered.key}\`)`;
  hookLabels.set(trigger, label);
  return { label, call: (context) => nodeType.lower(node, context) };
}

/**
 * The hook a trigger lowers through: a claimed node's type's `lower`
 * (dispatched on `node.type`), core's `mx:Trigger` (`lowerTrigger`) for a
 * `{ call }` row or a row naming it, and `undefined` for a built-in kind.
 */
function hookFor(
  dialect: Dialect | undefined,
  trigger: Node,
  row: unknown,
): TriggerHook | undefined {
  const node = trigger.claimed as RegisteredNode | undefined;
  if (node) return nodeTypeHook(dialect, trigger, node);
  if (isCallRow(row) || (isNodeTypeRow(row) && rowKey(row) === TRIGGER_KEY))
    return lowerTriggerHook(dialect, trigger);
  if (isNodeTypeRow(row)) return noLowering(trigger);
  return undefined;
}

/**
 * A hook's positioned error (`ctx.fail`): at the
 * trigger's text (after any `async` before it), or at `at`, carrying
 * `code` when given.
 */
function failAt(
  ctx: Ctx,
  trigger: Node,
  label: string,
  message: string,
  options: TriggerFailOptions | undefined,
): never {
  if (typeof message !== "string" || message === "") {
    return fail(
      `the \`${trigger.id}\` trigger's ${label}: \`ctx.fail\` takes a non-empty message`,
      trigger,
    );
  }
  const at = options?.at
    ? checkPart(ctx, trigger, options.at, "ctx.fail")
    : undefined;
  try {
    const own = asyncTextStart.has(trigger)
      ? { type: "MxTriggerPart", ...spanRange(trigger) }
      : trigger;
    return fail(message, at ?? own);
  } catch (error) {
    if (options?.code !== undefined && isTranslateError(error)) {
      (error as { diagnosticCode?: string }).diagnosticCode = String(
        options.code,
      );
    }
    throw error;
  }
}

function positionPhrase(position: TriggerPosition): string {
  return position === "expression"
    ? "an expression"
    : position === "attribute"
      ? "an attribute list"
      : "a tagless line";
}

/**
 * Builds the `TriggerContext` for one trigger and calls its hook (the
 * dialect's `lowerTrigger`, or a node type's `lower`). Whatever the hook
 * throws leaves positioned at the trigger: a `TranslateError` as is,
 * anything else wrapped.
 */
function callHook(
  ctx: Ctx,
  hook: TriggerHook,
  trigger: Node,
  value: TriggerExpression | TriggerMethod | null,
  use: TriggerUse = null,
  operator: string | null = null,
): TriggerResult {
  const valueForm = valueFormOf(trigger);
  const { label } = hook;
  const context: TriggerContext = Object.freeze({
    position: trigger.position as TriggerPosition,
    value,
    valueForm,
    use,
    operator,
    expression(node: object): TriggerExpression {
      const problem = notAnExpression(node);
      if (problem) {
        fail(
          `the \`${trigger.id}\` trigger's ${hookLabel(trigger)}: \`ctx.expression\` takes a Babel expression node, got ${problem}`,
          trigger,
        );
      }
      const result = Object.freeze({ kind: "expression" as const, node });
      built.add(result);
      return result;
    },
    attribute(
      name: string | null,
      attrValue: TriggerAttributeValue,
      options?: TriggerAttributeOptions,
    ): TriggerAttribute {
      if (name !== null && (typeof name !== "string" || name === "")) {
        fail(
          `the \`${trigger.id}\` trigger's ${hookLabel(trigger)}: \`ctx.attribute\` takes a non-empty attribute name, or \`null\` for the tag's default value`,
          trigger,
        );
      }
      checkAttributeValue(trigger, attrValue);
      checkAttributeOptions(trigger, options);
      if (options?.at) checkPart(ctx, trigger, options.at, "ctx.attribute");
      const result = Object.freeze({
        kind: "attribute" as const,
        name,
        value: attrValue,
        ...(options ? { options: Object.freeze({ ...options }) } : {}),
      });
      built.add(result);
      return result;
    },
    shorthand(attribute: "id" | "class", name: string): TriggerShorthand {
      if (attribute !== "id" && attribute !== "class") {
        fail(
          `the \`${trigger.id}\` trigger's ${hookLabel(trigger)}: \`ctx.shorthand\` takes \`"id"\` or \`"class"\``,
          trigger,
        );
      }
      if (typeof name !== "string" || name === "") {
        fail(
          `the \`${trigger.id}\` trigger's ${hookLabel(trigger)}: \`ctx.shorthand\` takes a non-empty name`,
          trigger,
        );
      }
      const result = Object.freeze({
        kind: "shorthand" as const,
        attribute,
        name,
      });
      built.add(result);
      return result;
    },
    child(tagName: string, attrs: readonly TriggerAttribute[]): TriggerChild {
      if (typeof tagName !== "string" || tagName === "") {
        fail(
          `the \`${trigger.id}\` trigger's ${hookLabel(trigger)}: \`ctx.child\` takes a non-empty tag name`,
          trigger,
        );
      }
      if (
        !Array.isArray(attrs) ||
        attrs.some((attr) => !built.has(attr) || attr.kind !== "attribute")
      ) {
        fail(
          `the \`${trigger.id}\` trigger's ${hookLabel(trigger)}: \`ctx.child\` takes an array of \`ctx.attribute\` results`,
          trigger,
        );
      }
      const result = Object.freeze({
        kind: "child" as const,
        tagName,
        attrs: Object.freeze([...attrs]),
      });
      built.add(result);
      return result;
    },
    fail(message: string, options?: TriggerFailOptions): never {
      return failAt(ctx, trigger, label, message, options);
    },
  });
  let result: TriggerResult;
  try {
    result = hook.call(context);
  } catch (error) {
    if (isTranslateError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return fail(
      `the \`${trigger.id}\` trigger's ${label} threw: ${message}`,
      trigger,
    );
  }
  const handMade = (item: unknown) =>
    !item || typeof item !== "object" || !built.has(item);
  if (
    Array.isArray(result)
      ? result.length === 0 || result.some(handMade)
      : handMade(result)
  ) {
    fail(
      `the \`${trigger.id}\` trigger's ${label} must return what \`ctx.expression\`, \`ctx.attribute\`, \`ctx.shorthand\` or \`ctx.child\` built (a non-empty list of attributes and shorthands in an attribute list)`,
      trigger,
    );
  }
  return result;
}

/**
 * A dialect's `at` span as a positioned node: inside the document
 * (`0 <= sourceStart <= sourceEnd <= source.length`), else the hook-contract
 * error at the trigger.
 */
function checkPart(
  ctx: Ctx,
  trigger: Node,
  at: SourceSpan,
  where: string,
): Node {
  if (
    !at ||
    typeof at !== "object" ||
    !Number.isInteger(at.sourceStart) ||
    !Number.isInteger(at.sourceEnd) ||
    at.sourceStart < 0 ||
    at.sourceStart > at.sourceEnd ||
    at.sourceEnd > ctx.source.length
  ) {
    return fail(
      `the \`${trigger.id}\` trigger's ${hookLabel(trigger)}: \`${where}\`'s \`at\` is a \`{ sourceStart, sourceEnd }\` span inside the document (0 to ${ctx.source.length})`,
      trigger,
    );
  }
  return { type: "MxTriggerPart", start: at.sourceStart, end: at.sourceEnd };
}

function checkAttributeOptions(
  trigger: Node,
  options: TriggerAttributeOptions | undefined,
): void {
  if (options === undefined) return;
  const bad = (what: string): never =>
    fail(
      `the \`${trigger.id}\` trigger's ${hookLabel(trigger)}: \`ctx.attribute\`'s options ${what}`,
      trigger,
    );
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    bad("are an object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "authored" && key !== "once" && key !== "at") {
      bad(`have no \`${key}\``);
    }
  }
  if (options.authored !== undefined && typeof options.authored !== "boolean") {
    bad("take a boolean `authored`");
  }
  if (
    options.once !== undefined &&
    (typeof options.once !== "string" || options.once === "")
  ) {
    bad("take a non-empty message as `once`");
  }
}

function checkAttributeValue(
  trigger: Node,
  value: TriggerAttributeValue,
): void {
  if (value === true || typeof value === "string") return;
  if (value && typeof value === "object") {
    if (
      (value.kind === "expression" || value.kind === "method") &&
      built.has(value)
    ) {
      return;
    }
    if (
      (value.kind === "atom" || value.kind === "member") &&
      typeof (value as { name?: unknown }).name === "string" &&
      (value as { name: string }).name !== ""
    ) {
      return;
    }
    if (
      value.kind === "node" &&
      value.node !== undefined &&
      value.node === trigger.claimed &&
      typeof value.value === "string"
    ) {
      return;
    }
  }
  fail(
    `the \`${trigger.id}\` trigger's ${hookLabel(trigger)}: an attribute value is \`true\`, a string, a \`ctx.expression\` result, the trigger's own method value, \`{ kind: "atom" | "member", name }\`, or \`{ kind: "node", node, value }\` with the node being lowered`,
    trigger,
  );
}

/** The row's node kind, or a positioned error when the row is gone (a table/document mismatch). */
function rowFor(table: SyntaxTable, trigger: Node) {
  const row = triggerRow(table, trigger);
  if (!row) {
    fail(
      `the \`${trigger.id}\` trigger has no row in the syntax table (not yours: an internal bug)`,
      trigger,
    );
  }
  return row as NonNullable<typeof row>;
}

function noLowering(trigger: Node): never {
  return fail(`\`${trigger.id}\` trigger has no lowering yet`, trigger);
}

function badKind(trigger: Node, kind: string): never {
  return fail(
    `the \`${trigger.id}\` trigger's \`node: "${kind}"\` has no meaning in ${positionPhrase(trigger.position)}; use \`{ call }\` and a dialect's \`lowerTrigger\``,
    trigger,
  );
}

// --- expressions -----------------------------------------------------------

/** Keys that never lead to a payload node. */
const SKIP = new Set([
  "loc",
  "extra",
  "start",
  "end",
  "range",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);

interface Site {
  node: Node;
  parent: Node | null;
  key: string;
  index: number | null;
  /** The nodes from the payload root to `parent`, with the key each was reached by. */
  path: { node: Node; key: string }[];
}

/** The payload node the parser marked for `trigger` (`extra.mxTrigger`), with where it sits. */
function markedSite(container: Node, trigger: Node): Site | undefined {
  const root = container.node;
  let found: Site | undefined;
  const path: { node: Node; key: string }[] = [];
  const visit = (
    node: Node,
    parent: Node | null,
    key: string,
    index: number | null,
  ): void => {
    if (found || !node || typeof node !== "object") return;
    if (typeof node.type !== "string") return;
    const mark = node.extra?.mxTrigger;
    if (
      mark &&
      mark.id === trigger.id &&
      mark.span?.sourceStart === trigger.start
    ) {
      found = { node, parent, key, index, path: [...path] };
      return;
    }
    path.push({ node, key });
    for (const [childKey, child] of Object.entries(node)) {
      if (SKIP.has(childKey) || !child || typeof child !== "object") continue;
      if (Array.isArray(child)) {
        child.forEach((item, i) => {
          visit(item, node, childKey, i);
        });
      } else visit(child, node, childKey, null);
    }
    path.pop();
  };
  // A container's payload is a node, or a list: call arguments
  // (`MxArguments`), a method's parameters (`MxParameterList`) and a
  // method's or statement block's statements (`MxStatements`). A list's
  // items sit in `container.node`, and the container heads the path, so
  // `inBindingPosition` sees a parameter list as the parameters' parent.
  if (Array.isArray(root)) {
    path.push({ node: container, key: "" });
    root.forEach((item, i) => {
      visit(item, container, "node", i);
    });
    path.pop();
  } else visit(root, null, "", null);
  return found;
}

const FUNCTIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
  "TSDeclareFunction",
  "TSDeclareMethod",
]);

/**
 * Does the marked node stand where a name is declared: a parameter, a
 * declarator, a catch parameter, or anywhere inside a pattern in one of
 * those? A trigger lowers to an expression (`self.x`), which cannot be
 * declared.
 */
function inBindingPosition(site: Site): boolean {
  const chain = [...site.path, { node: site.node, key: site.key }];
  // Walk up from the marked node through pattern wrappers.
  for (let i = chain.length - 1; i >= 1; i--) {
    const { key } = chain[i] as { node: Node; key: string };
    const parent = (chain[i - 1] as { node: Node }).node;
    switch (parent.type) {
      case "ObjectPattern":
      case "ArrayPattern":
      case "RestElement":
      case "TSParameterProperty":
        continue;
      case "AssignmentPattern":
        if (key === "left") continue;
        return false;
      case "ObjectProperty":
        // A property is a pattern's only when its own parent is one.
        if (
          key === "value" &&
          (chain[i - 2] as { node: Node } | undefined)?.node.type ===
            "ObjectPattern"
        ) {
          continue;
        }
        return false;
      case "VariableDeclarator":
        return key === "id";
      case "CatchClause":
        return key === "param";
      // A method's parameters (`x m(&a) {}`), reached through the pattern
      // wrappers above; a default value's right side returned already.
      case "MxParameterList":
        return true;
      default:
        return FUNCTIONS.has(parent.type) && key === "params";
    }
  }
  return false;
}

/** Gives a replacement the stand-in's offsets, where the dialect left them out. */
function positioned(replacement: Node, standIn: Node): Node {
  for (const key of ["start", "end", "loc", "range"]) {
    if (replacement[key] === undefined && standIn[key] !== undefined) {
      replacement[key] = standIn[key];
    }
  }
  return replacement;
}

function replaceAt(container: Node, site: Site, replacement: Node): void {
  if (!site.parent) {
    container.node = replacement;
  } else if (site.index !== null) {
    site.parent[site.key][site.index] = replacement;
  } else {
    site.parent[site.key] = replacement;
  }
}

/**
 * Is the marked node a property's name rather than a value: a non-computed
 * key, or a shorthand property (`{ &a }`, whose key and value are one token)?
 */
function inKeyPosition(site: Site): boolean {
  const parent = site.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "ObjectProperty":
      return (
        parent.shorthand === true || (site.key === "key" && !parent.computed)
      );
    case "ObjectMethod":
    case "ClassProperty":
    case "ClassMethod":
    case "ClassAccessorProperty":
    case "TSPropertySignature":
    case "TSMethodSignature":
      return site.key === "key" && !parent.computed;
    default:
      return false;
  }
}

function notWholeOperand(trigger: Node): never {
  return fail(
    `\`${trigger.text}\` is not a whole operand here: the \`${trigger.id}\` trigger lowers to an expression; write it where a value stands`,
    trigger,
  );
}

/** How the marked operand is used (`TriggerUse`), from its parent, or its container's owner at the payload root. */
function useOf(site: Site, owner: Node | null): TriggerUse {
  const parent = site.parent;
  if (!parent) {
    return owner?.type === "MxSpreadAttribute" ? "spread" : null;
  }
  if (inKeyPosition(site)) return "key";
  switch (parent.type) {
    case "MemberExpression":
    case "OptionalMemberExpression":
      return site.key === "object" ? "member-object" : null;
    case "CallExpression":
    case "OptionalCallExpression":
    case "NewExpression":
      return site.key === "callee" ? "callee" : null;
    case "TaggedTemplateExpression":
      return site.key === "tag" ? "callee" : null;
    case "UnaryExpression":
      return "unary";
    case "SpreadElement":
      return "spread";
    default:
      return null;
  }
}

/** A whole string literal marked as an atom (`extra.mxAtom`): `expr()` splices it as an atom. */
function isAtomLiteral(node: Node): boolean {
  return node?.type === "StringLiteral" && !!node.extra?.mxAtom;
}

function lowerExpressionTriggers(
  ctx: Ctx,
  run: SyntaxRun,
  container: Node,
  owner: Node | null,
): void {
  const { table, dialect } = run.syntax;
  for (const trigger of container.triggers ?? []) {
    if (lowered.has(trigger)) continue;
    const row = rowFor(table, trigger);
    // Unparsed payloads keep their error for `payloadOf`.
    if (container.node == null) return;
    if (isNodeTypeRow(row.node)) {
      // The table check refuses this row; a hand-built document may not.
      fail(
        `the \`${trigger.id}\` trigger names a node type (\`${row.node.dialect}:${row.node.type}\`), which has no meaning in an expression yet; use \`{ call }\` and the dialect's \`lowerTrigger\``,
        trigger,
      );
    }
    if (isCallRow(row.node) && !dialect?.lowerTrigger) {
      noLowering(trigger);
    }
    const site = markedSite(container, trigger);
    if (!site) notWholeOperand(trigger);
    const at = site as Site;
    if (inBindingPosition(at)) {
      fail(
        `\`${trigger.text}\` (the \`${trigger.id}\` trigger) cannot be declared: it lowers to an expression, and a parameter or declaration needs a plain name`,
        trigger,
      );
    }
    // A property name (`{ &a: 1 }`, `{ &a }`) is no operand: an expression
    // there is an invalid key, and a shorthand would keep the stand-in. A
    // dialect may refuse it in its own words first (`ctx.use` is "key").
    const use = useOf(at, owner);
    if (use === "key" && !isCallRow(row.node)) notWholeOperand(trigger);
    const mark = at.node.extra?.mxTrigger;
    let replacement: Node;
    if (row.node === "string") {
      replacement = {
        type: "StringLiteral",
        value: trigger.text,
        extra: {
          raw: JSON.stringify(trigger.text),
          rawValue: trigger.text,
          mxTrigger: mark,
        },
      };
    } else if (row.node === "identifier") {
      replacement = {
        type: "Identifier",
        name: trigger.text,
        extra: { mxTrigger: mark },
      };
    } else if (row.node === "attribute") {
      badKind(trigger, "attribute");
    } else {
      const result = callHook(
        ctx,
        lowerTriggerHook(dialect, trigger),
        trigger,
        null,
        use,
        use === "unary" ? String(at.parent?.operator) : null,
      );
      if (use === "key") notWholeOperand(trigger);
      if (
        Array.isArray(result) ||
        (result as { kind: string }).kind !== "expression"
      )
        wrongResult(trigger, "ctx.expression(node)");
      replacement = (result as TriggerExpression).node as Node;
    }
    replaceAt(container, at, positioned(replacement, at.node));
    // The expression's `code` is spliced from the source: the trigger's
    // text becomes the replacement's printed code. A replacement marked as
    // an atom is recorded with the atoms instead (`convertAtoms` after this
    // pass), which splice and map it exactly as a built-in atom.
    if (!isAtomLiteral(replacement)) {
      run.splices.push({
        ...spanRange(trigger),
        text: printed(ctx, replacement, trigger),
      });
    }
    lowered.add(trigger);
  }
}

// --- attributes and children ----------------------------------------------

/** How the trigger's own value is written (`ctx.valueForm`). */
function valueFormOf(trigger: Node): TriggerValueForm {
  if (trigger.args) return "arguments";
  if (!trigger.value) return null;
  if (trigger.value.type === "MxMethod") {
    return trigger.value.async ? "async-method" : "method";
  }
  return trigger.operator === ":=" ? ":=" : "=";
}

/** A bound value or arguments after an attribute trigger: nothing can place them. */
function refuseUnplaceable(trigger: Node): void {
  const form = valueFormOf(trigger);
  if (form === ":=") {
    fail(
      `\`${trigger.text}\` takes no bound value (\`:=\`): the \`${trigger.id}\` trigger cannot place one`,
      trigger.value ?? trigger,
    );
  }
  if (form === "arguments") {
    fail(
      `\`${trigger.text}\` takes no arguments: the \`${trigger.id}\` trigger cannot place them`,
      trigger.args ?? trigger,
    );
  }
}

/** The value behind a trigger's `=value` container, or its method value (`:x() { … }`). */
function triggerValue(trigger: Node): TriggerExpression | TriggerMethod | null {
  const container = trigger.value;
  if (!container) return null;
  const result: TriggerExpression | TriggerMethod =
    container.type === "MxMethod"
      ? Object.freeze({
          kind: "method" as const,
          async: container.async === true,
        })
      : Object.freeze({
          kind: "expression" as const,
          node: container.node as object,
        });
  built.add(result);
  containers.set(result, container);
  return result;
}

/** The zero-width span at the `=` before a value starting at `start` (`&a = 1` included). */
function equalsAt(ctx: Ctx, start: number): { start: number; end: number } {
  const at = ctx.source.lastIndexOf("=", start - 1);
  const offset = at >= 0 ? at : start;
  return { start: offset, end: offset };
}

/** A Babel `loc` for `[start, end)`, as the front end gives payload nodes. */
function locOf(ctx: Ctx, start: number, end: number): Node {
  return {
    start: { ...positionAtOffset(ctx, start), index: start },
    end: { ...positionAtOffset(ctx, end), index: end },
  };
}

/** A synthesized `MxExpression` over `node`, spanning `[start, end)`. */
function containerOf(ctx: Ctx, node: Node, start: number, end: number): Node {
  return {
    type: "MxExpression",
    start,
    end,
    source: ctx.source.slice(start, end),
    outer: { start, end },
    node,
    error: null,
    atoms: [],
  };
}

/** The `StringLiteral` a static string, atom or member value lowers through. */
function literal(
  ctx: Ctx,
  value: string,
  start: number,
  end: number,
  extra: Record<string, unknown> = {},
): Node {
  return {
    type: "StringLiteral",
    start,
    end,
    loc: locOf(ctx, start, end),
    value,
    extra: { raw: JSON.stringify(value), rawValue: value, ...extra },
  };
}

/**
 * An `MxAttribute` for an attribute result. Positions come from the trigger:
 * the name covers the trigger's text, except a value taken from the
 * trigger's own `=value`, which is named at the `=` (zero width, the
 * default-attribute convention). A string value spans its occurrence in the
 * trigger's text when it has one (`title` in `&title`), else the text.
 */
function attributeNode(ctx: Ctx, trigger: Node, attr: TriggerAttribute): Node {
  // The part of the trigger's text that spells this attribute (`at`), else
  // all of it.
  const text = attr.options?.at ?? spanOf(trigger);
  const spelled = ctx.source.slice(text.sourceStart, text.sourceEnd);
  const value = attr.value;
  const ownValue =
    typeof value === "object" &&
    (value.kind === "expression" || value.kind === "method")
      ? containers.get(value)
      : undefined;
  // A method value is named zero-width at its start (Marko's anchor for a
  // default method), an `=value` at its `=`.
  const nameSpan =
    ownValue?.type === "MxMethod"
      ? { start: ownValue.start, end: ownValue.start }
      : ownValue
        ? equalsAt(ctx, ownValue.outer.start)
        : { start: text.sourceStart, end: text.sourceEnd };
  let container: Node | null = null;
  if (value === true) {
    container = null;
  } else if (typeof value === "string") {
    const at = spelled.indexOf(value);
    const [start, end] =
      value !== "" && at >= 0
        ? [text.sourceStart + at, text.sourceStart + at + value.length]
        : [text.sourceStart, text.sourceEnd];
    container = containerOf(ctx, literal(ctx, value, start, end), start, end);
  } else if (ownValue) {
    container = ownValue;
  } else if (value.kind === "method") {
    // Only the trigger's own method value is ever built (`ctx.value`).
    return fail(
      `the \`${trigger.id}\` trigger's ${hookLabel(trigger)}: a method value is the trigger's own \`ctx.value\``,
      trigger,
    );
  } else if (value.kind === "expression") {
    // A module-built expression spans the trigger's text, and its `code` is
    // the expression printed (spliced over that text, like an expression
    // trigger's replacement).
    const node = positioned(value.node as Node, {
      start: text.sourceStart,
      end: text.sourceEnd,
      loc: locOf(ctx, text.sourceStart, text.sourceEnd),
    });
    ctx.triggerSplices?.push({
      start: text.sourceStart,
      end: text.sourceEnd,
      text: printed(ctx, node, trigger),
    });
    container = containerOf(ctx, node, text.sourceStart, text.sourceEnd);
  } else if (value.kind === "node") {
    // The static string every target emits, spanning the node's text; the
    // attribute holds the node (`dialectNode`), which lowering puts on
    // `Attr.node`.
    const span = value.span ?? value.node.span;
    container = containerOf(
      ctx,
      literal(ctx, value.value, span.sourceStart, span.sourceEnd),
      span.sourceStart,
      span.sourceEnd,
    );
  } else {
    const span = value.span ?? text;
    const mark =
      value.kind === "member"
        ? { mxMember: { span, name: value.name } }
        : { mxAtom: { span } };
    // The value spans the name where the text spells it (`email` in
    // `:email`), as a string value does; the mark keeps the whole token.
    const at = value.span ? -1 : spelled.indexOf(value.name);
    const [start, end] =
      at > 0
        ? [text.sourceStart + at, text.sourceStart + at + value.name.length]
        : [span.sourceStart, span.sourceEnd];
    container = containerOf(
      ctx,
      literal(ctx, value.name, start, end, mark),
      start,
      end,
    );
  }
  const authored = attr.options?.authored === true;
  return {
    type: "MxAttribute",
    // The default value is anchored at its value, Marko's anchor.
    start: attr.name === null && container ? container.start : text.sourceStart,
    end: attr.name === null && container ? container.end : text.sourceEnd,
    name: attr.name,
    nameSpan,
    modifier: null,
    modifierSpan: null,
    operator: container && container.type !== "MxMethod" ? "=" : null,
    value: container,
    args: null,
    mxTrigger: { id: trigger.id, span: text },
    ...(typeof value === "object" && value.kind === "node"
      ? { dialectNode: value.node }
      : {}),
    // Spelled by the trigger's text: diagnostics name it, and lowering
    // copies it to `Attr.sugar` (decision 156 addendum 6).
    // A default value the trigger's own value sets is named by it instead
    // (`set by \`:n=…\``), as a contract's error on `value` says.
    ...(authored && attr.name === null && ownValue
      ? {
          sugarValueOf: `${spelled}${ownValue.type === "MxMethod" ? "(…)" : "=…"}`,
        }
      : authored
        ? {
            sugarLabel: spelled,
            sugarNameSpan: { start: text.sourceStart, end: text.sourceEnd },
          }
        : {}),
    ...(attr.options?.once ? { mxOnce: attr.options.once } : {}),
    // A default value the trigger's own value sets is written from the
    // trigger through the value (`:n=2`), as `once`'s `{written}` names it.
    ...(attr.name === null && ownValue
      ? { mxWritten: { start: trigger.start, end: ownValue.end } }
      : {}),
  };
}

/**
 * The `MxShorthand` a `ctx.shorthand` result places: what the parser builds
 * for a tag-adjacent `#name` / `.name`, at the part of the trigger's text
 * that spells it (searched from `from`), else over the whole text.
 */
function shorthandNode(
  trigger: Node,
  shorthand: TriggerShorthand,
  from: number,
): { node: Node; end: number } {
  const sigil = shorthand.attribute === "id" ? "#" : ".";
  const text = String(trigger.text);
  const at = text.indexOf(`${sigil}${shorthand.name}`, from);
  const textStart = spanOf(trigger).sourceStart;
  const [start, end] =
    at >= 0
      ? [textStart + at, textStart + at + 1 + shorthand.name.length]
      : [textStart, textStart + text.length];
  const nameStart = at >= 0 ? start + 1 : start;
  return {
    node: {
      type: "MxShorthand",
      start,
      end,
      sigil,
      position: "attribute",
      value: {
        kind: "static",
        value: shorthand.name,
        span: { start: nameStart, end },
      },
      operator: null,
      default: null,
      args: null,
      mxTrigger: { id: trigger.id, span: spanOf(trigger) },
    },
    end: at >= 0 ? at + 1 + shorthand.name.length : from,
  };
}

/** The attributes (and shorthands) an attribute trigger lowers to, in order. */
function lowerAttributeTrigger(
  ctx: Ctx,
  table: SyntaxTable,
  dialect: Dialect | undefined,
  trigger: Node,
): Node[] {
  const row = rowFor(table, trigger);
  if (trigger.value?.type === "MxMethod" && trigger.value.async) {
    // `async` and whitespace come first; the text is the trigger's own.
    const at = ctx.source.indexOf(String(trigger.text), trigger.start + 5);
    if (at >= 0) asyncTextStart.set(trigger, at);
  }
  let results: readonly (TriggerAttribute | TriggerShorthand)[];
  if (row.node === "attribute") {
    refuseUnplaceable(trigger);
    const value = triggerValue(trigger);
    if (value?.kind === "method") {
      return fail(
        `the \`${trigger.id}\` trigger's \`node: "attribute"\` takes no method value; use \`{ call }\` and a dialect's \`lowerTrigger\``,
        trigger.value ?? trigger,
      );
    }
    // Named by the text after the trigger's first character (the sigil):
    // the sigil itself is never a valid first character of a name.
    results = [
      {
        kind: "attribute",
        name: String(trigger.text).slice(1),
        value: value ?? true,
      },
    ];
  } else if (isCallRow(row.node) || isNodeTypeRow(row.node)) {
    const hook = hookFor(dialect, trigger, row.node) as TriggerHook;
    const value = triggerValue(trigger);
    const result = callHook(ctx, hook, trigger, value);
    const list = Array.isArray(result) ? result : [result];
    if (
      list.some(
        (item: { kind: string }) =>
          item.kind !== "attribute" && item.kind !== "shorthand",
      )
    ) {
      wrongResult(trigger, "ctx.attribute(name, value)");
    }
    results = list as (TriggerAttribute | TriggerShorthand)[];
    refuseUnplaceable(trigger);
    const attrs = results.filter(
      (item): item is TriggerAttribute => item.kind === "attribute",
    );
    if (value && !usesValue(attrs, value)) droppedValue(trigger);
  } else {
    return [badKind(trigger, row.node)];
  }
  lowered.add(trigger);
  let from = 0;
  return results.map((item) => {
    if (item.kind === "attribute") return attributeNode(ctx, trigger, item);
    const placed = shorthandNode(trigger, item, from);
    from = placed.end;
    return placed.node;
  });
}

/**
 * `ctx.attribute(…, { once })`: a second attribute of that name on the tag,
 * written or built, is the dialect's error, at the later of the two. The
 * default value is one name however it is written (`<x=1>`, `value=1`,
 * `value:=y`; Marko's default attribute is `value`). In the message,
 * `{written}` is the later attribute as written (a built default value from
 * its trigger through its value) and `{first}` the earlier one's
 * `line:column`.
 */
function checkOnce(ctx: Ctx, attributes: readonly Node[]): void {
  const isDefault = (node: Node) =>
    node.name === null ||
    (node.name === "value" && (node.modifier == null || node.modifier === ""));
  const sameName = (a: Node, b: Node) =>
    a.name === b.name || (isDefault(a) && isDefault(b));
  for (const attr of attributes) {
    if (!attr?.mxOnce) continue;
    const other = attributes.find(
      (candidate) =>
        candidate !== attr &&
        candidate?.type === "MxAttribute" &&
        sameName(candidate, attr),
    );
    if (!other) continue;
    const [first, later] =
      other.start <= attr.start ? [other, attr] : [attr, other];
    const written = later.mxWritten ?? { start: later.start, end: later.end };
    const at = positionAtOffset(ctx, first.start);
    fail(
      String(attr.mxOnce)
        .replaceAll("{written}", ctx.source.slice(written.start, written.end))
        .replaceAll("{first}", `${at.line}:${at.column + 1}`),
      later,
    );
  }
}

/**
 * Lowers a tag's attribute trigger nodes, in order, once each, and checks
 * `once` over the list they make.
 */
function mapAttributes(
  ctx: Ctx,
  table: SyntaxTable,
  dialect: Dialect | undefined,
  tag: Node,
): void {
  const attributes: Node[] = tag.attributes;
  if (!attributes.some(isTriggerNode)) return;
  const list = attributes.flatMap((attr) => {
    if (!isTriggerNode(attr)) return [attr];
    let results = loweredNodes.get(attr) as Node[] | undefined;
    if (!results) {
      results = lowerAttributeTrigger(
        ctx,
        table,
        dialect,
        triggerOf(ctx, table, attr, "attribute"),
      );
      loweredNodes.set(attr, results);
    }
    return results;
  });
  checkOnce(ctx, list);
}

/** Does one of `attrs` carry the trigger's own `=value` (`ctx.value`, or its node)? */
function usesValue(
  attrs: readonly TriggerAttribute[],
  value: TriggerExpression | TriggerMethod,
): boolean {
  return attrs.some(
    (attr) =>
      typeof attr.value === "object" &&
      (attr.value === value ||
        (value.kind === "expression" &&
          attr.value.kind === "expression" &&
          attr.value.node === value.node)),
  );
}

/**
 * A `=value` the hook's result does not carry would vanish from the output
 * with nothing said; it is an error at the trigger instead. The text is the
 * user's: it names the trigger, not the hook (review 460 F6).
 */
function droppedValue(trigger: Node): never {
  const what = trigger.value?.type === "MxMethod" ? "method value" : "`=value`";
  return fail(
    `\`${trigger.text}\` takes no ${what} here: the \`${trigger.id}\` trigger does not place it`,
    trigger.value ?? trigger,
  );
}

/** The `MxTag` a line trigger lowers to (`ctx.child`). */
function lowerLineTrigger(
  ctx: Ctx,
  table: SyntaxTable,
  dialect: Dialect | undefined,
  trigger: Node,
): Node {
  const row = rowFor(table, trigger);
  const hook = hookFor(dialect, trigger, row.node);
  if (!hook) return badKind(trigger, row.node as string);
  const value = triggerValue(trigger);
  const result = callHook(ctx, hook, trigger, value);
  if (Array.isArray(result) || (result as { kind: string }).kind !== "child")
    wrongResult(trigger, "ctx.child(tagName, attrs)");
  const child = result as TriggerChild;
  if (value && !usesValue(child.attrs, value)) droppedValue(trigger);
  const text = spanOf(trigger);
  lowered.add(trigger);
  return {
    type: "MxTag",
    start: trigger.start,
    end: trigger.end,
    name: {
      kind: "static",
      value: child.tagName,
      span: { start: text.sourceStart, end: text.sourceEnd },
    },
    typeArgs: null,
    var: null,
    args: null,
    typeParams: null,
    params: null,
    shorthands: [],
    attributes: child.attrs.map((attr) => attributeNode(ctx, trigger, attr)),
    body: [],
    bodyMode: "html",
    selfClosed: false,
    concise: true,
    openTag: { start: trigger.start, end: trigger.end },
    closeTag: null,
    incomplete: false,
    mxTrigger: { id: trigger.id, span: text, text: String(trigger.text) },
  };
}

/** Lowers a body's line trigger node, once. */
function lowerChild(
  ctx: Ctx,
  table: SyntaxTable,
  dialect: Dialect | undefined,
  child: Node,
): void {
  if (!isTriggerNode(child) || loweredNodes.has(child)) return;
  const trigger = triggerOf(ctx, table, child, "line");
  if (trigger.position !== "line") return;
  loweredNodes.set(child, lowerLineTrigger(ctx, table, dialect, trigger));
}
