/**
 * Layer-2 trigger lowering (decision 182 addendum 5): what a syntax table's
 * triggers become before anything reads the tree.
 *
 * One pass per document, run by `lower`/`lowerChildren` right after the atom
 * conversion, calls the syntax module's `lowerTrigger` once per trigger in
 * source order (a value's own triggers before the trigger that owns it) and
 * resolves the built-in node kinds without a hook:
 *
 * - an expression trigger's stand-in is replaced, inside its container's
 *   payload, by the node `ctx.expression(node)` carries (or the built-in
 *   string literal / identifier); the container's authored `source` and
 *   every offset stay as written;
 * - an attribute trigger becomes an ordinary `MxAttribute`, kept beside the
 *   tree and read by `tagAttributesOf`;
 * - a line trigger becomes an ordinary `MxTag` (`ctx.child`), kept beside
 *   the tree and read by `bodyChildren` and the root walk, so the tag goes
 *   through the normal tag path (contracts and declarations apply).
 *
 * The parsed tree stays as parsed, like the name-sugar records (decision 158,
 * PR 4 slice 4). A trigger this pass never reached (a document lowered with
 * no registered syntax, a `{ call }` with no `lowerTrigger`) is refused at
 * the seams (`payloadOf`, `lowerChildList`, the attribute list) with "has no
 * lowering yet".
 */
import {
  type Ctx,
  fail,
  isTranslateError,
  markoBabel,
  type Node,
  positionAtOffset,
} from "./core.ts";
import type { Member, MxMemberMark } from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";
import type {
  ResolvedSyntax,
  SyntaxModule,
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

/** Attribute lists with their attribute triggers replaced, per tag. */
const triggerAttributes = new WeakMap<Node, Node[]>();

/** A tag's attributes as authored, its attribute triggers lowered (the name-sugar pass reads these). */
export function attributesWithTriggers(tag: Node): Node[] {
  return triggerAttributes.get(tag) ?? tag?.attributes ?? [];
}

/** Child lists with their line triggers replaced, per body array. */
const triggerChildren = new WeakMap<readonly unknown[], Node[]>();

/** A body's children, its line triggers lowered. */
export function childrenWithTriggers<T>(children: readonly T[]): T[] {
  return (
    (triggerChildren.get(children) as T[] | undefined) ?? (children as T[])
  );
}

/** Results built by a `TriggerContext`, so a hand-made object is refused. */
const built = new WeakSet<object>();

/** The `MxExpression` container behind an expression result. */
const containers = new WeakMap<object, Node>();

/** Lowered once per `Ctx`: the module's `afterLower` and `productName`. */
const applied = new WeakSet<Ctx>();

/**
 * Lowers every trigger under `roots` (see the file header). Idempotent: a
 * trigger already lowered is skipped, so a second walk (a scratch `Ctx`)
 * calls no hook twice.
 */
export function lowerTriggers(ctx: Ctx, roots: readonly Node[]): boolean {
  const run = syntaxRuns.get(roots);
  if (!run) return false;
  const { table, module } = run.syntax;
  ctx.triggerSplices = run.splices;
  ctx.syntaxModule = module;
  if (module && !applied.has(ctx)) {
    applied.add(ctx);
    if (module.afterLower) {
      ctx.afterLower = [...(ctx.afterLower ?? []), module.afterLower];
    }
    if (module.productName && ctx.productName === undefined) {
      ctx.productName = module.productName;
    }
  }
  const seen = new WeakSet<object>();
  // `owner` is the node holding `value` (arrays pass it through): a
  // container's owner tells a spread (`<div ...x/>`) from other uses.
  const visit = (value: Node, owner: Node | null): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, owner);
      mapChildren(ctx, table, module, value);
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
    // A tag's attributes before its body, in source order.
    if (Array.isArray(value.attributes)) {
      visit(value.attributes, value);
      mapAttributes(ctx, table, module, value);
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

function spanOf(trigger: Node): SourceSpan {
  return {
    sourceStart: trigger.start,
    sourceEnd: trigger.start + String(trigger.text).length,
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
  const t = markoBabel().types;
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
    `the \`${trigger.id}\` trigger's \`lowerTrigger\` must return \`${want}\` for a trigger in ${positionPhrase(trigger.position)}`,
    trigger,
  );
}

function positionPhrase(position: TriggerPosition): string {
  return position === "expression"
    ? "an expression"
    : position === "attribute"
      ? "an attribute list"
      : "a tagless line";
}

/**
 * Builds the `TriggerContext` for one trigger and calls `lowerTrigger`.
 * Whatever the hook throws leaves positioned at the trigger: a
 * `TranslateError` as is, anything else wrapped.
 */
function callHook(
  ctx: Ctx,
  module: SyntaxModule,
  trigger: Node,
  value: TriggerExpression | TriggerMethod | null,
  use: TriggerUse = null,
  operator: string | null = null,
): TriggerResult {
  const valueForm = valueFormOf(trigger);
  const hook = module.lowerTrigger as NonNullable<SyntaxModule["lowerTrigger"]>;
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
          `the \`${trigger.id}\` trigger's \`lowerTrigger\`: \`ctx.expression\` takes a Babel expression node, got ${problem}`,
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
          `the \`${trigger.id}\` trigger's \`lowerTrigger\`: \`ctx.attribute\` takes a non-empty attribute name, or \`null\` for the tag's default value`,
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
          `the \`${trigger.id}\` trigger's \`lowerTrigger\`: \`ctx.shorthand\` takes \`"id"\` or \`"class"\``,
          trigger,
        );
      }
      if (typeof name !== "string" || name === "") {
        fail(
          `the \`${trigger.id}\` trigger's \`lowerTrigger\`: \`ctx.shorthand\` takes a non-empty name`,
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
          `the \`${trigger.id}\` trigger's \`lowerTrigger\`: \`ctx.child\` takes a non-empty tag name`,
          trigger,
        );
      }
      if (
        !Array.isArray(attrs) ||
        attrs.some((attr) => !built.has(attr) || attr.kind !== "attribute")
      ) {
        fail(
          `the \`${trigger.id}\` trigger's \`lowerTrigger\`: \`ctx.child\` takes an array of \`ctx.attribute\` results`,
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
      if (typeof message !== "string" || message === "") {
        return fail(
          `the \`${trigger.id}\` trigger's \`lowerTrigger\`: \`ctx.fail\` takes a non-empty message`,
          trigger,
        );
      }
      const at = options?.at
        ? checkPart(ctx, trigger, options.at, "ctx.fail")
        : undefined;
      try {
        return fail(message, at ?? trigger);
      } catch (error) {
        if (options?.code !== undefined && isTranslateError(error)) {
          (error as { diagnosticCode?: string }).diagnosticCode = String(
            options.code,
          );
        }
        throw error;
      }
    },
  });
  let result: TriggerResult;
  try {
    result = hook(trigger.id, trigger.text, spanOf(trigger), context);
  } catch (error) {
    if (isTranslateError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return fail(
      `the \`${trigger.id}\` trigger's \`lowerTrigger\` threw: ${message}`,
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
      `the \`${trigger.id}\` trigger's \`lowerTrigger\` must return what \`ctx.expression\`, \`ctx.attribute\`, \`ctx.shorthand\` or \`ctx.child\` built (a non-empty list of attributes and shorthands in an attribute list)`,
      trigger,
    );
  }
  return result;
}

/**
 * A module's `at` span as a positioned node: inside the document
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
      `the \`${trigger.id}\` trigger's \`lowerTrigger\`: \`${where}\`'s \`at\` is a \`{ sourceStart, sourceEnd }\` span inside the document (0 to ${ctx.source.length})`,
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
      `the \`${trigger.id}\` trigger's \`lowerTrigger\`: \`ctx.attribute\`'s options ${what}`,
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
  }
  fail(
    `the \`${trigger.id}\` trigger's \`lowerTrigger\`: an attribute value is \`true\`, a string, a \`ctx.expression\` result, the trigger's own method value, or \`{ kind: "atom" | "member", name }\``,
    trigger,
  );
}

/** The row's node kind, or a positioned error when the row is gone (a table/document mismatch). */
function rowFor(table: SyntaxTable, trigger: Node) {
  const row = triggerRow(table, trigger);
  if (!row) {
    fail(
      `the \`${trigger.id}\` trigger has no row in the syntax table (not yours: an MX bug)`,
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
    `the \`${trigger.id}\` trigger's \`node: "${kind}"\` has no meaning in ${positionPhrase(trigger.position)}; use \`{ call }\` and a syntax module's \`lowerTrigger\``,
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

/** Gives a replacement the stand-in's offsets, where the module left them out. */
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
  const { table, module } = run.syntax;
  for (const trigger of container.triggers ?? []) {
    if (lowered.has(trigger)) continue;
    const row = rowFor(table, trigger);
    // Unparsed payloads keep their error for `payloadOf`.
    if (container.node == null) return;
    if (typeof row.node === "object" && !module?.lowerTrigger) {
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
    // module may refuse it in its own words first (`ctx.use` is "key").
    const use = useOf(at, owner);
    if (use === "key" && typeof row.node !== "object") notWholeOperand(trigger);
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
        module as SyntaxModule,
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
function valueFormOf(
  trigger: Node,
): "=" | ":=" | "method" | "arguments" | null {
  if (trigger.args) return "arguments";
  if (!trigger.value) return null;
  if (trigger.value.type === "MxMethod") return "method";
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
      ? Object.freeze({ kind: "method" as const })
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
      `the \`${trigger.id}\` trigger's \`lowerTrigger\`: a method value is the trigger's own \`ctx.value\``,
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
  const [start, end] =
    at >= 0
      ? [trigger.start + at, trigger.start + at + 1 + shorthand.name.length]
      : [trigger.start, trigger.start + text.length];
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
  module: SyntaxModule | undefined,
  trigger: Node,
): Node[] {
  const row = rowFor(table, trigger);
  let results: readonly (TriggerAttribute | TriggerShorthand)[];
  if (row.node === "attribute") {
    refuseUnplaceable(trigger);
    const value = triggerValue(trigger);
    if (value?.kind === "method") {
      return fail(
        `the \`${trigger.id}\` trigger's \`node: "attribute"\` takes no method value; use \`{ call }\` and a syntax module's \`lowerTrigger\``,
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
  } else if (typeof row.node === "object") {
    if (!module?.lowerTrigger) noLowering(trigger);
    const value = triggerValue(trigger);
    const result = callHook(ctx, module as SyntaxModule, trigger, value);
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
 * written or built, is the module's error, at the later of the two. The
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

function mapAttributes(
  ctx: Ctx,
  table: SyntaxTable,
  module: SyntaxModule | undefined,
  tag: Node,
): void {
  const attributes: Node[] = tag.attributes;
  if (triggerAttributes.has(tag)) return;
  if (!attributes.some((attr) => attr?.type === "MxTrigger")) return;
  const lowered = attributes.flatMap((attr) =>
    attr?.type === "MxTrigger"
      ? lowerAttributeTrigger(ctx, table, module, attr)
      : [attr],
  );
  checkOnce(ctx, lowered);
  triggerAttributes.set(tag, lowered);
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
 * with nothing said; it is an error at the trigger instead.
 */
function droppedValue(trigger: Node): never {
  const what = trigger.value?.type === "MxMethod" ? "method value" : "`=value`";
  return fail(
    `\`${trigger.text}\` takes no ${what} here: the \`${trigger.id}\` trigger's \`lowerTrigger\` did not use it`,
    trigger.value ?? trigger,
  );
}

/** The `MxTag` a line trigger lowers to (`ctx.child`). */
function lowerLineTrigger(
  ctx: Ctx,
  table: SyntaxTable,
  module: SyntaxModule | undefined,
  trigger: Node,
): Node {
  const row = rowFor(table, trigger);
  if (typeof row.node !== "object") return badKind(trigger, row.node);
  if (!module?.lowerTrigger) noLowering(trigger);
  const value = triggerValue(trigger);
  const result = callHook(ctx, module as SyntaxModule, trigger, value);
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

function mapChildren(
  ctx: Ctx,
  table: SyntaxTable,
  module: SyntaxModule | undefined,
  children: Node[],
): void {
  if (triggerChildren.has(children)) return;
  if (
    !children.some(
      (child) => child?.type === "MxTrigger" && child.position === "line",
    )
  ) {
    return;
  }
  triggerChildren.set(
    children,
    children.map((child) =>
      child?.type === "MxTrigger" && child.position === "line"
        ? lowerLineTrigger(ctx, table, module, child)
        : child,
    ),
  );
}
