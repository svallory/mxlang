/**
 * The host-independent Custom Tag contract.
 *
 * A caller discovers and loads tag definitions before compilation, then hands
 * them to the core as a name-to-definition map. The core owns validation and
 * transformation; hosts receive only ordinary IR and never learn that a
 * custom tag existed.
 */

import type { Ctx, Node } from "./core.ts";
import { TranslateError, warn } from "./core.ts";
import type {
  Attr,
  AttributeTag,
  Block,
  Branch,
  Expr,
  ForSource,
  IrNode,
  Position,
} from "./ir.ts";
import {
  expandTemplate,
  hasTemplate,
  type TemplateBackedTag,
} from "./template-tag.ts";

export interface CustomTagParseOptions {
  /** Body arrives as one unparsed text node. */
  text?: boolean;
  /** Keep body whitespace. */
  preserveWhitespace?: boolean;
  /** The tag may not have a body. */
  openTagOnly?: boolean;
}

export interface CustomTagAttribute {
  type?: "string" | "number" | "boolean" | "expression";
  required?: boolean;
  enum?: string[];
  default?: unknown;
  /** Reject a runtime expression when the tag needs a literal value. */
  literalOnly?: boolean;
}

export interface CustomTagAttributeTag {
  repeatable?: boolean;
  required?: boolean;
}

/**
 * One tag's private, per-file scratch space.
 *
 * Shared by that tag's `analyze`, `transform` and `finalize` for one file and
 * nothing else: the map is created with the file's `Ctx` and dies with it, and
 * it is keyed by tag name, so neither another file's compile nor another tag
 * in the same file can read or write it. That isolation is what makes the
 * collecting pair safe to use from a tag template's own call sites and from a
 * long-lived language server, where one definition object is reused across
 * every file it ever compiles.
 */
export interface TagStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

export interface AnalyzeContext {
  store: TagStore;
  fail(message: string, at?: Position): never;
}

export interface FinalizeContext {
  store: TagStore;
  build: IrBuilders;
  gensym(hint?: string): string;
}

/** One call site, with every author-written part already lowered to IR. */
export interface TagCall {
  name: string;
  loc: Position;
  attrs: Attr[];
  content: Block | null;
  attributeTags: AttributeTag[];
  params: string[];
  var: string | null;
}

export interface TransformContext {
  /** Builders that stamp synthetic nodes with the call site's position. */
  build: IrBuilders;
  /** A hygienic, per-file-unique binding name. */
  gensym(hint?: string): string;
  /** Write `throw ctx.fail(...)` so TypeScript narrows the failed branch. */
  fail(message: string, at?: Position): never;
  /** Lifts a statement to the head of the enclosing function. */
  hoist(code: string): void;
  /** Typed now; accessing it fails clearly until phase 5 implements stores. */
  store: TagStore;
}

/** The default export of an `x.tag.ts` sidecar. */
export interface CustomTag {
  parseOptions?: CustomTagParseOptions;
  attributes?: Record<string, CustomTagAttribute>;
  attributeTags?: Record<string, CustomTagAttributeTag>;
  analyze?(calls: readonly TagCall[], ctx: AnalyzeContext): void;
  transform?(call: TagCall, ctx: TransformContext): IrNode[];
  finalize?(ctx: FinalizeContext): IrNode[];
}

/** Builders available to a transform. Module-level IR is deliberately absent. */
export interface IrBuilders {
  text(value: string): IrNode;
  interpolation(expr: Expr, escaped?: boolean): IrNode;
  element(
    name: string,
    attrs?: Attr[],
    children?: IrNode[],
    options?: { void?: boolean },
  ): IrNode;
  attr(name: string, value: string): Attr;
  dynamicAttr(name: string, value: Expr): Attr;
  booleanAttr(name: string): Attr;
  expr(code: string): Expr;
  ifChain(
    branches: Array<{ condition: Expr | null; children: IrNode[] }>,
  ): IrNode;
  forLoop(options: {
    source: ForSource;
    params: string[];
    bindings?: string[];
    key?: Expr | null;
    children: IrNode[];
  }): IrNode;
  block(children: IrNode[], params?: string[]): Block;
  /** Requests a primitive from the active host without exposing that host. */
  hostTag(
    name: string,
    children: IrNode[],
    attributeTags: AttributeTag[],
  ): IrNode;
  /**
   * Expands this tag's own template (`tags/x.mx`) with a call's inputs.
   *
   * Available only to a tag that has a template beside it. It is what makes
   * L1 and L2 compose rather than compete: a sidecar's `transform` wins over
   * the template, and this is how that transform uses the template as raw
   * material — validate or compute first, then `return ctx.build.template(call)`
   * — instead of having to rebuild the markup with the other builders.
   *
   * A sidecar with no `transform` at all (a *declaration-only* sidecar, one
   * that adds `attributes` or `parseOptions`) needs no call: the template
   * still expands, now validated.
   */
  template(call: TagCall): IrNode[];
}

export const MAX_EXPANSION_DEPTH = 64;
export const MAX_EXPANSION_NODES = 100_000;

const CUSTOM_TAGLIB_ID = "mx-custom-tags";

function parserTaglibId(
  customTags: Readonly<Record<string, CustomTag>>,
): string {
  // Marko caches injected taglibs by id for the life of the process. Include
  // the complete parser-facing definition in that id so two compilations with
  // different custom tag maps cannot accidentally reuse the first lookup.
  const signature = Object.entries(customTags)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => [name, definition.parseOptions ?? null]);
  return `${CUSTOM_TAGLIB_ID}:${JSON.stringify(signature)}`;
}

/**
 * The error a registered name shadowing a core-owned built-in (`<try>`)
 * always throws, wherever it is caught.
 *
 * Two call sites throw it: `customTagTaglib` below (registration-time, before
 * any parsing — the one place both compile entry points, `compile.ts`'s
 * whole-file compile and `fragment.ts`'s `.solid.mx`/TS-plugin path, hand the
 * complete `customTags` map over) and `lowerTag`'s call-site check (which
 * only ever sees a name Marko has already agreed to parse as that tag).
 * Without the registration-time check, a shadowing registration that also
 * set `parseOptions` (e.g. `try: { parseOptions: { openTagOnly: true } }`)
 * changed how the parser itself read `<try>` before lowering ever ran,
 * surfacing as an unrelated parser error instead of this diagnostic.
 */
export function shadowedBuiltinMessage(name: string): string {
  return `\`<${name}>\` is a core-owned custom tag and cannot be shadowed by a registered custom tag of the same name`;
}

/**
 * Converts registered tags into the parser-only part of a Marko taglib.
 *
 * Hooks and attribute declarations never enter the compiler's taglib: some
 * similarly named Marko keys are executable Babel hooks with incompatible
 * signatures. Only the three approved parser switches cross this boundary.
 */
export function customTagTaglib(
  customTags: Readonly<Record<string, CustomTag>> | undefined,
): [string, unknown] | null {
  if (!customTags || Object.keys(customTags).length === 0) return null;

  const definitions: Record<string, unknown> = Object.create(null);
  for (const [name, definition] of Object.entries(customTags)) {
    const configured = definition.parseOptions;
    const parseOptions = configured
      ? {
          ...(configured.text === undefined ? {} : { text: configured.text }),
          ...(configured.preserveWhitespace === undefined
            ? {}
            : { preserveWhitespace: configured.preserveWhitespace }),
          ...(configured.openTagOnly === undefined
            ? {}
            : { openTagOnly: configured.openTagOnly }),
        }
      : undefined;
    definitions[`<${name}>`] = parseOptions ? { parseOptions } : {};
  }
  return [parserTaglibId(customTags), definitions];
}

function syntheticExpr(code: string): Expr {
  return { code, shape: "other", node: null as unknown as Node };
}

function failAt(tagName: string, message: string, at: Position): never {
  throw new TranslateError(`\`<${tagName}>\`: ${message}`, at.line, at.column);
}

function buildersFor(
  loc: Position,
  ctx: Ctx,
  node: Node | null,
  tagName: string,
  definition: CustomTag,
): IrBuilders {
  return {
    text: (value) => ({ kind: "Text", value, loc }),
    interpolation: (value, escaped = true) => ({
      kind: "Interpolation",
      expr: value,
      escaped,
      loc,
    }),
    element: (name, attrs = [], children = [], options = {}) => ({
      kind: "Element",
      name,
      attrs,
      children,
      void: options.void ?? false,
      loc,
    }),
    attr: (name, value) => ({
      kind: "static",
      name,
      value,
      nameSpan: { sourceStart: 0, sourceEnd: 0 },
      loc,
    }),
    dynamicAttr: (name, value) => ({
      kind: "dynamic",
      name,
      value,
      nameSpan: { sourceStart: 0, sourceEnd: 0 },
      loc,
    }),
    booleanAttr: (name) => ({
      kind: "boolean",
      name,
      nameSpan: { sourceStart: 0, sourceEnd: 0 },
      loc,
    }),
    expr: syntheticExpr,
    ifChain: (branches) => ({
      kind: "IfChain",
      branches: branches.map((branch): Branch => ({ ...branch, loc })),
      loc,
    }),
    forLoop: (options) => ({
      kind: "For",
      source: options.source,
      params: options.params,
      paramNodes: [],
      bindings: options.bindings ?? options.params,
      key: options.key ?? null,
      children: options.children,
      loc,
    }),
    block: (children, params = []) => ({
      hasParams: params.length > 0,
      params,
      children,
      loc,
    }),
    hostTag: (name, children, attributeTags) => {
      if (node === null) {
        return failAt(
          tagName,
          "`ctx.build.hostTag` is not available in `finalize`",
          loc,
        );
      }
      if (ctx.declarations.claimsTag?.(name, ctx) !== true) {
        return failAt(
          tagName,
          `this host does not claim \`<${name}>\`, so a custom tag cannot emit one`,
          loc,
        );
      }
      return {
        kind: "HostTag",
        tag: {
          name,
          attrs: [],
          children,
          attributeTags,
          params: [],
          var: null,
          data: ctx.declarations.resolveHostTag?.(name, node, ctx),
          loc,
        },
        loc,
      };
    },
    template: (call) => {
      if (node === null) {
        return failAt(
          tagName,
          "`ctx.build.template` is not available in `finalize`",
          loc,
        );
      }
      if (!hasTemplate(definition)) {
        return failAt(
          tagName,
          "this tag has no template file, so `ctx.build.template(call)` has nothing to expand",
          loc,
        );
      }
      return expandTemplate(ctx, definition, call);
    },
  };
}

interface LiteralValue {
  type: "string" | "number" | "boolean";
  value: string | number | boolean;
}

function listEnum(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function literalValue(attr: Attr): LiteralValue | null {
  if (attr.kind === "static") return { type: "string", value: attr.value };
  if (attr.kind === "boolean") return { type: "boolean", value: true };
  if (attr.kind !== "dynamic") return null;

  switch (attr.value.node?.type) {
    case "StringLiteral":
      return { type: "string", value: attr.value.node.value };
    case "NumericLiteral":
      return { type: "number", value: attr.value.node.value };
    case "BooleanLiteral":
      return { type: "boolean", value: attr.value.node.value };
    default:
      return null;
  }
}

/**
 * Whether an attribute's value is fixed at compile time.
 *
 * Wider than `literalValue`, deliberately. `literalValue` answers "which of
 * `string`/`number`/`boolean` is this?" for the `type` and `enum` checks, so it
 * is scalar by construction. `literalOnly` asks a different question — "can this
 * tag read this value now, rather than emit code that reads it later?" — and a
 * tag that takes a list (`<table-of columns=["name", "price"]>`) or a lookup
 * map needs that answer to be yes for an array or object literal whose members
 * are themselves literals. Composite values are still not `literalValue`s, so
 * declaring a `type` or an `enum` alongside keeps its scalar meaning.
 */
function isLiteralNode(node: Node | null | undefined): boolean {
  switch (node?.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
      return true;
    case "ArrayExpression":
      return (node.elements as Array<Node | null>).every((element) =>
        isLiteralNode(element),
      );
    case "ObjectExpression":
      return (node.properties as Node[]).every(
        (property) =>
          property.type === "ObjectProperty" &&
          property.computed !== true &&
          (property.key.type === "Identifier" ||
            property.key.type === "StringLiteral") &&
          isLiteralNode(property.value),
      );
    case "UnaryExpression":
      // `-1` is a `UnaryExpression` over a `NumericLiteral`, not a literal of
      // its own, and rejecting it would make a negative default unwritable.
      return node.operator === "-" && isLiteralNode(node.argument);
    default:
      return false;
  }
}

function isLiteralAttr(attr: Attr): boolean {
  if (attr.kind === "static" || attr.kind === "boolean") return true;
  if (attr.kind !== "dynamic") return false;
  return isLiteralNode(attr.value.node);
}

/**
 * Materializes a declared `default` as the attribute the call omitted.
 *
 * A default is applied after validation, so a call that supplies the attribute
 * is checked on its own value and a default is never re-checked against the
 * declaration that produced it. Only a literal default can become an `Attr`:
 * the attribute a transform reads has to be indistinguishable from one the
 * author wrote, which means carrying a real literal node so `literalValue`
 * reads the same type back. A non-literal default has no such spelling and is
 * a definition error rather than something silently dropped.
 */
function defaultAttr(
  tagName: string,
  name: string,
  value: unknown,
  loc: Position,
): Attr {
  const nameSpan = { sourceStart: 0, sourceEnd: 0 };
  if (typeof value === "string") {
    return { kind: "static", name, value, nameSpan, loc };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const code = String(value);
    const node = {
      type: typeof value === "number" ? "NumericLiteral" : "BooleanLiteral",
      value,
    } as unknown as Node;
    return {
      kind: "dynamic",
      name,
      value: { code, shape: "other", node },
      nameSpan,
      loc,
    };
  }
  return failAt(
    tagName,
    `attribute \`${name}\` declares a \`default\` that is not a string, number or boolean, so it has no attribute spelling`,
    loc,
  );
}

/**
 * Returns `call.attrs` with every omitted, defaulted attribute appended.
 *
 * Returns the original array when nothing is defaulted, so the common case
 * allocates nothing and author order is untouched.
 */
export function applyCustomTagDefaults(
  definition: CustomTag,
  call: TagCall,
): Attr[] {
  const attributes = definition.attributes;
  if (!attributes) return call.attrs;

  const present = new Set<string>();
  for (const attr of call.attrs) {
    if (attr.kind !== "spread") present.add(attr.name);
  }

  const defaulted: Attr[] = [];
  for (const [name, declaration] of Object.entries(attributes)) {
    if (declaration.default === undefined || present.has(name)) continue;
    defaulted.push(defaultAttr(call.name, name, declaration.default, call.loc));
  }
  return defaulted.length === 0 ? call.attrs : [...call.attrs, ...defaulted];
}

/** Enforces a tag's closed attribute contract before its transform runs. */
export function validateCustomTagCall(
  definition: CustomTag,
  call: TagCall,
): void {
  const attributes = definition.attributes;
  if (attributes) {
    // A tag declaring no attributes at all (`attributes: {}`) rejects a
    // spread the same way it rejects a named one: "cannot be checked" is
    // true of every declaration, so it describes the checker rather than the
    // author's actual mistake — writing an attribute where the tag accepts
    // none.
    const acceptsNone = Object.keys(attributes).length === 0;
    const present = new Set<string>();
    for (const attr of call.attrs) {
      if (attr.kind === "spread") {
        failAt(
          call.name,
          acceptsNone
            ? "accepts no attributes"
            : "spread attributes cannot be checked against this tag's declared attributes",
          attr.loc,
        );
      }
      const declaration = Object.hasOwn(attributes, attr.name)
        ? attributes[attr.name]
        : undefined;
      if (!declaration) {
        failAt(
          call.name,
          acceptsNone
            ? "accepts no attributes"
            : `unknown attribute \`${attr.name}\``,
          attr.loc,
        );
      }
      present.add(attr.name);

      const literal = literalValue(attr);
      if (declaration.literalOnly && !isLiteralAttr(attr)) {
        failAt(
          call.name,
          `attribute \`${attr.name}\` must be a literal`,
          attr.loc,
        );
      }
      if (
        declaration.type &&
        declaration.type !== "expression" &&
        literal &&
        declaration.type !== literal.type
      ) {
        failAt(
          call.name,
          `attribute \`${attr.name}\` must be ${declaration.type}, got ${literal.type}`,
          attr.loc,
        );
      }
      if (
        declaration.type === "expression" &&
        (attr.kind === "static" || attr.kind === "boolean")
      ) {
        failAt(
          call.name,
          `attribute \`${attr.name}\` must be an expression`,
          attr.loc,
        );
      }
      if (declaration.enum) {
        if (!literal) {
          failAt(
            call.name,
            `attribute \`${attr.name}\` must be a static value from ${listEnum(declaration.enum)}`,
            attr.loc,
          );
        }
        // `enum` is `string[]`, so only a string literal can be a member.
        // Comparing through `String()` would let `<t mode/>` (boolean `true`)
        // satisfy `enum: ["true"]` and `mode=24` satisfy `enum: ["24"]`; the
        // declared `type` is the value's real type, so require it to match.
        const enumType = declaration.type ?? "string";
        if (
          enumType !== "string" ||
          literal.type !== "string" ||
          typeof literal.value !== "string"
        ) {
          failAt(
            call.name,
            `attribute \`${attr.name}\` must be a string from ${listEnum(declaration.enum)}, got ${literal.type}`,
            attr.loc,
          );
        }
        if (!declaration.enum.includes(literal.value)) {
          failAt(
            call.name,
            `attribute \`${attr.name}\` must be one of ${listEnum(declaration.enum)}, got ${JSON.stringify(literal.value)}`,
            attr.loc,
          );
        }
      }
    }

    for (const [name, declaration] of Object.entries(attributes)) {
      if (declaration.required && !present.has(name)) {
        failAt(call.name, `missing required attribute \`${name}\``, call.loc);
      }
    }
  }

  const declaredTags = definition.attributeTags;
  if (!declaredTags) return;

  const seen = new Map<string, AttributeTag>();
  for (const tag of call.attributeTags) {
    const declaration = Object.hasOwn(declaredTags, tag.name)
      ? declaredTags[tag.name]
      : undefined;
    if (!declaration) {
      failAt(call.name, `unknown attribute tag \`<@${tag.name}>\``, tag.loc);
    }
    if (seen.has(tag.name) && declaration.repeatable !== true) {
      failAt(
        call.name,
        `attribute tag \`<@${tag.name}>\` may not be repeated`,
        tag.loc,
      );
    }
    seen.set(tag.name, tag);
  }
  for (const [name, declaration] of Object.entries(declaredTags)) {
    if (declaration.required && !seen.has(name)) {
      failAt(
        call.name,
        `missing required attribute tag \`<@${name}>\``,
        call.loc,
      );
    }
  }
}

function countNodes(nodes: IrNode[]): number {
  let total = 0;
  const pending = [...nodes];
  const enqueue = (children: IrNode[]) => {
    for (const child of children) pending.push(child);
  };
  for (let node = pending.pop(); node; node = pending.pop()) {
    total++;
    if (total > MAX_EXPANSION_NODES) return total;
    if ("children" in node && Array.isArray(node.children)) {
      enqueue(node.children as IrNode[]);
    }
    if (node.kind === "IfChain") {
      for (const branch of node.branches) enqueue(branch.children);
    }
    if (node.kind === "Component") {
      if (node.content) enqueue(node.content.children);
      for (const tag of node.attributeTags) {
        enqueue(tag.block.children);
      }
    }
    if (node.kind === "HostTag") {
      enqueue(node.tag.children);
      for (const tag of node.tag.attributeTags) {
        enqueue(tag.block.children);
      }
    }
  }
  return total;
}

/**
 * The store for one tag in one file, created on first use.
 *
 * Hung off the file's `Ctx` rather than off the definition object: a
 * definition is a module-level singleton that the scan hands to every file in
 * a package, so keying by definition would leak one file's collected state
 * into the next — the exact failure a sprite sheet would show as symbols from
 * a page the reader never opened.
 */
export function storeFor(ctx: Ctx, tagName: string): TagStore {
  ctx.customTagStores ??= new Map();
  const stores = ctx.customTagStores;
  const existing = stores.get(tagName);
  const entries = existing ?? new Map<string, unknown>();
  if (!existing) stores.set(tagName, entries);
  return {
    get<T>(key: string): T | undefined {
      return entries.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      entries.set(key, value);
    },
  };
}

/**
 * Rejects a registration whose hooks can never run.
 *
 * `finalize` reads what `analyze` or `transform` collected; on its own it has
 * nothing to read and no call site to be reached from, so a tag that declares
 * only `finalize` is a definition mistake — most often a `transform` that was
 * renamed or deleted. Failing at registration names the tag once, before any
 * file is parsed, instead of silently emitting a constant prelude into every
 * file in the package.
 *
 * A tag with `analyze` but no `finalize` is *not* rejected: `transform` reads
 * the same store, which is how a call's output legitimately depends on the set
 * of calls without any prepended program node.
 */
export function rejectUnreachableHooks(
  customTags: Readonly<Record<string, CustomTag>> | undefined,
): void {
  if (!customTags) return;
  for (const [name, definition] of Object.entries(customTags)) {
    if (!definition.finalize) continue;
    if (definition.analyze || definition.transform || hasTemplate(definition)) {
      continue;
    }
    throw new TranslateError(
      `\`<${name}>\`: a custom tag that defines only \`finalize\` has no call site and nothing to collect; add a \`transform\`, an \`analyze\` or a template file`,
      0,
      0,
    );
  }
}

const ATTRIBUTE_KEYS = [
  "type",
  "required",
  "enum",
  "default",
  "literalOnly",
] as const;
const ATTRIBUTE_TAG_KEYS = ["repeatable", "required"] as const;

/**
 * Rejects an unknown key in a registered tag's `attributes`/`attributeTags`
 * declarations, at registration time, before any file is parsed.
 *
 * These declaration objects are read directly at runtime (`literalOnly`,
 * `repeatable`, ...) with no schema check of their own — a `.tag.ts` sidecar
 * is loaded through `require` and type-stripped, so a renamed or misspelled
 * key (`staticOnly`, `repeated`, `requried`) would otherwise register
 * silently and its option would simply never apply. There is deliberately no
 * legacy alias for the retired `staticOnly`/`repeated` names: they fail this
 * check exactly like any other unknown key.
 */
export function rejectUnknownDeclarationKeys(
  customTags: Readonly<Record<string, CustomTag>> | undefined,
): void {
  if (!customTags) return;
  for (const [tagName, definition] of Object.entries(customTags)) {
    if (definition.attributes) {
      for (const [attrName, declaration] of Object.entries(
        definition.attributes,
      )) {
        for (const key of Object.keys(declaration)) {
          if (!(ATTRIBUTE_KEYS as readonly string[]).includes(key)) {
            throw new TranslateError(
              `Unknown key "${key}" in the "${attrName}" attribute declaration of tag "${tagName}"; allowed: ${ATTRIBUTE_KEYS.join(", ")}`,
              0,
              0,
            );
          }
        }
      }
    }
    if (definition.attributeTags) {
      for (const [tagAttrName, declaration] of Object.entries(
        definition.attributeTags,
      )) {
        for (const key of Object.keys(declaration)) {
          if (!(ATTRIBUTE_TAG_KEYS as readonly string[]).includes(key)) {
            throw new TranslateError(
              `Unknown key "${key}" in the "${tagAttrName}" attribute tag declaration of tag "${tagName}"; allowed: ${ATTRIBUTE_TAG_KEYS.join(", ")}`,
              0,
              0,
            );
          }
        }
      }
    }
  }
}

/**
 * Runs every registered `analyze`, once per tag, over that tag's own calls.
 *
 * Ordered by tag name for the same reason `finalize` is: two tags whose
 * `analyze` hooks both observe something about the file must observe it in an
 * order that does not depend on `Object.keys` insertion, which follows
 * registration and therefore the scan's directory listing.
 *
 * A tag with no calls in the file is skipped rather than analyzed with an
 * empty array: "this file uses no icons" and "this file was not scanned for
 * icons" are the same state to a `finalize` that reads an absent key, and
 * skipping keeps the store untouched so a tag cannot accidentally prepend a
 * sheet to a file that never called it.
 */
export function runAnalyzeHooks(
  ctx: Ctx,
  customTags: Readonly<Record<string, CustomTag>>,
  calls: Map<string, TagCall[]>,
): void {
  const names = [...calls.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const name of names) {
    const definition = customTags[name];
    const analyze = definition?.analyze;
    if (!analyze) continue;
    const tagCalls = calls.get(name) ?? [];
    const first = tagCalls[0];
    if (!first) continue;
    // A bare `analyze` failure has no one call to blame, so it is positioned
    // at the tag's first call in the file — the earliest place an author can
    // start reading to understand what the whole set looked like.
    const analyzeContext: AnalyzeContext = {
      store: storeFor(ctx, name),
      fail: (message, at) => failAt(name, message, at ?? first.loc),
    };
    try {
      analyze(tagCalls, analyzeContext);
    } catch (error) {
      throw wrapHookError(error, name, "analyze", first.loc);
    }
  }
}

/**
 * Runs every registered `finalize` and returns the nodes to prepend, in order.
 *
 * Two rules make the result reproducible on any machine: hooks run **sorted by
 * tag name**, and each may only contribute nodes — it is handed no other tag's
 * output and no way to reach the program, so ordering can never become
 * semantically load-bearing (decision 80's coupling, reintroduced through the
 * back door). The returned list is prepended to the program body as a whole,
 * so tag `a`'s nodes precede tag `b`'s whatever order the calls appeared in.
 *
 * Only a tag actually *called in this file* is finalized. A package may
 * register dozens of tags a given file never uses, and a `finalize` that ran
 * regardless would prepend its (usually empty, occasionally not) output to
 * every file in the package.
 */
export function runFinalizeHooks(
  ctx: Ctx,
  customTags: Readonly<Record<string, CustomTag>>,
  used: ReadonlySet<string>,
): IrNode[] {
  const names = [...used].sort((left, right) => left.localeCompare(right));
  const prepended: IrNode[] = [];
  for (const name of names) {
    const finalize = customTags[name]?.finalize;
    if (!finalize) continue;
    const loc: Position = { line: 0, column: 0 };
    const finalizeContext: FinalizeContext = {
      store: storeFor(ctx, name),
      // A finalize node belongs to no call site, so its builders are stamped
      // at the head of the file — the position a diagnostic about a prepended
      // node can honestly point at.
      build: buildersFor(loc, ctx, null, name, {}),
      gensym: (hint) => gensymFor(ctx, name, hint),
    };
    let nodes: IrNode[];
    try {
      nodes = finalize(finalizeContext);
    } catch (error) {
      throw wrapHookError(error, name, "finalize", loc);
    }
    if (!Array.isArray(nodes)) {
      failAt(name, "`finalize` must return an array of IR nodes", loc);
    }
    const total = countNodes(nodes);
    if (total > MAX_EXPANSION_NODES) {
      failAt(
        name,
        `\`finalize\` produced ${total} nodes, over the ${MAX_EXPANSION_NODES} limit`,
        loc,
      );
    }
    prepended.push(...nodes);
  }
  return prepended;
}

/** A hook's own `TranslateError` passes through; anything else is wrapped. */
function wrapHookError(
  error: unknown,
  tagName: string,
  hook: string,
  loc: Position,
): unknown {
  if (error instanceof TranslateError) return error;
  return new TranslateError(
    `\`<${tagName}>\`: custom tag \`${hook}\` threw: ${error instanceof Error ? error.message : String(error)}`,
    loc.line,
    loc.column,
    loc.file,
  );
}

/** The per-file hygienic name generator, shared by every context that has one. */
function gensymFor(ctx: Ctx, tagName: string, hint?: string): string {
  ctx.customTagGensym = (ctx.customTagGensym ?? 0) + 1;
  const serial = ctx.customTagGensym;
  const safeTag = tagName.replace(/[^A-Za-z0-9_]/g, "_");
  const safeHint = (hint ?? "t").replace(/[^A-Za-z0-9_]/g, "_");
  return `$mx_${safeTag}_${safeHint}${serial}`;
}

function observedCall(call: TagCall): {
  call: TagCall;
  attributeTagsRead(): boolean;
} {
  let read = false;
  return {
    call: new Proxy(call, {
      get(target, property, receiver) {
        if (property === "attributeTags") read = true;
        return Reflect.get(target, property, receiver);
      },
    }),
    attributeTagsRead: () => read,
  };
}

/** Runs a validated transform and normalizes its failures to TranslateError. */
export function transformCustomTag(
  ctx: Ctx,
  definition: CustomTag,
  call: TagCall,
  node: Node,
): IrNode[] {
  if (!definition.transform && !hasTemplate(definition)) {
    failAt(
      call.name,
      "custom tag has neither a `transform` nor a template file, so a call has nothing to expand to",
      call.loc,
    );
  }

  validateCustomTagCall(definition, call);
  const withDefaults: TagCall = {
    ...call,
    attrs: applyCustomTagDefaults(definition, call),
  };

  // A real template compile must retain the calls its cached IR contains so
  // a later analyze-pass cache hit can observe the same nested calls without
  // rerunning transforms. Nested-template metadata is replayed into this map
  // by `expandTemplate`, making the resulting cache entry transitive.
  const templateCalls = ctx.customTagTemplateCalls;
  if (templateCalls && templateCalls !== ctx.customTagAnalyzePass?.calls) {
    const recorded = templateCalls.get(call.name);
    if (recorded) recorded.push(withDefaults);
    else templateCalls.set(call.name, [withDefaults]);
  }

  // The analyze pre-pass. Validation above has already run, so a bad call is
  // reported once at its real position rather than twice or (worse) only on
  // the second walk; from here the call is merely recorded and expands to
  // nothing, because its `transform` must not run until every `analyze` in
  // the file has seen every call. A template-backed tag is still expanded on
  // this scratch walk: its own nested custom-tag calls are part of the file's
  // call set, even though neither its transform nor any nested transform runs.
  const analyzePass = ctx.customTagAnalyzePass;
  if (analyzePass) {
    const recorded = analyzePass.calls.get(call.name);
    if (recorded) {
      recorded.push(withDefaults);
    } else {
      analyzePass.calls.set(call.name, [withDefaults]);
    }
    if (hasTemplate(definition)) {
      expandTemplate(ctx, definition as TemplateBackedTag, withDefaults);
    }
    return [];
  }
  const observed = observedCall(withDefaults);
  const builders = buildersFor(call.loc, ctx, node, call.name, definition);
  const tagContext: TransformContext = {
    build: builders,
    hoist: (code) => ctx.hoist(code, node),
    fail: (message, at) => failAt(call.name, message, at ?? call.loc),
    gensym: (hint) => gensymFor(ctx, call.name, hint),
    store: storeFor(ctx, call.name),
  };

  let nodes: IrNode[];
  try {
    // The sidecar wins when it has a `transform`: it may call
    // `ctx.build.template(call)` to expand the template with the call's
    // inputs, or ignore the template entirely and build its own IR. A
    // declaration-only sidecar — `attributes`/`parseOptions` and no
    // `transform` — expands the template as an L1-only tag does, now
    // validated by the declarations it added.
    nodes = definition.transform
      ? definition.transform(observed.call, tagContext)
      : expandTemplate(ctx, definition as TemplateBackedTag, observed.call);
  } catch (error) {
    if (error instanceof TranslateError) throw error;
    throw new TranslateError(
      `\`<${call.name}>\`: custom tag threw: ${error instanceof Error ? error.message : String(error)}`,
      call.loc.line,
      call.loc.column,
    );
  }

  if (!Array.isArray(nodes)) {
    failAt(call.name, "custom tag must return an array of IR nodes", call.loc);
  }
  const total = countNodes(nodes);
  if (total > MAX_EXPANSION_NODES) {
    failAt(
      call.name,
      `custom tag expansion produced ${total} nodes, over the ${MAX_EXPANSION_NODES} limit`,
      call.loc,
    );
  }
  // A template expansion reports its own, more precise version of this
  // warning (it knows which placeholder was missing), and reads
  // `attributeTags` through a path this proxy does not see, so the generic
  // check applies only to a real `transform`.
  if (
    definition.transform &&
    call.attributeTags.length > 0 &&
    !observed.attributeTagsRead()
  ) {
    warn(ctx, {
      message: `\`<${call.name}>\`: custom tag transform did not read its attributeTags; authored attribute tags were dropped`,
      line: call.loc.line,
      column: call.loc.column,
      file: call.loc.file,
    });
  }
  return nodes;
}
