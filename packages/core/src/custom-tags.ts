/**
 * The host-independent Custom Tag contract.
 *
 * A caller discovers and loads tag definitions before compilation, then hands
 * them to the core as a name-to-definition map. The core owns validation and
 * transformation; hosts receive only ordinary IR and never learn that a
 * custom tag existed.
 */

import { positionAt } from "./atom-contracts.ts";
import { attrLabel } from "./attr-label.ts";
import {
  fallbackAttrTagShape,
  unifyNestedAttrTagPlanGroups,
} from "./attr-tag.ts";
import type { Ctx, Node } from "./core.ts";
import { isTranslateError, TranslateError, warn } from "./core.ts";
import type {
  Attr,
  AttributeTag,
  AttributeTagNode,
  AttrTagProp,
  Block,
  Branch,
  Expr,
  ForSource,
  IrNode,
  Position,
  TagAlias,
} from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";
import {
  hasTemplate,
  routeTemplateCall,
  type TemplateBackedTag,
} from "./template-tag.ts";
import {
  entryRegExp,
  explicitChildEntries,
  hasExplicitChild,
  INLINE_CONTRACT_KEYS,
  matchWildcardEntry,
  tagLabel,
  WILDCARD,
  WILDCARD_ENTRY_KEYS,
  wildcardEntries,
} from "./wildcard-children.ts";

export interface CustomTagParseOptions {
  /** Body arrives as one unparsed text node. */
  text?: boolean;
  /** Keep body whitespace. */
  preserveWhitespace?: boolean;
  /** The tag may not have a body. */
  openTagOnly?: boolean;
}

export interface CustomTagAttribute {
  /**
   * `array` and `function` check the written shape: a literal array, or an
   * arrow function, function expression or method shorthand. An identifier,
   * call, member or conditional has no knowable type and is accepted, as for
   * `string` and `number`.
   */
  type?:
    | "string"
    | "number"
    | "boolean"
    | "expression"
    | "array"
    | "function"
    | "atom";
  /**
   * `type: "atom"` only (decision 156): the allowed names, like an enum. An
   * atom (`:name`), or a list of them, is checked name by name.
   */
  values?: string[];
  /** `type: "atom"` only: a regex source string every atom name must match. */
  pattern?: string;
  /**
   * `type: "atom"` only: the atom must name a declaration of this kind (or one
   * of these kinds) visible from the reference, in this file.
   */
  ref?: string | string[];
  /** The literal element type of an `array` attribute; a non-literal element passes. */
  items?: "string" | "number" | "boolean";
  required?: boolean;
  enum?: string[];
  default?: unknown;
  /** Reject a runtime expression when the tag needs a literal value. */
  literalOnly?: boolean;
}

export interface CustomTagAttributeTag {
  /**
   * What an unnamed tag (`<#id>`, `<.class>`) directly inside this attribute
   * tag stands for (decision 145). The same key as on a tag's own contract.
   */
  defaultTag?: string;
  repeatable?: boolean;
  required?: boolean;
  /** Closed attributes; omitted attributes remain open on an extended declaration. Defaults are not applied. */
  attributes?: Record<string, CustomTagAttribute>;
  /** Recursive closed attribute-tag contract. */
  attributeTags?: Record<string, CustomTagAttributeTag>;
  /** Closed authored children, with the reserved `#text` class and the `"*"` wildcard. */
  children?: CustomTagChildren;
}

/** Cardinality of an authored plain child (or the reserved `#text` class). */
export interface CustomTagChild {
  repeatable?: boolean;
  required?: boolean;
}

/**
 * One `children["*"]` entry (decision 147): an optional `pattern`, then either
 * a `contract` reference or an inline contract (never both).
 */
export interface WildcardChildEntry {
  /**
   * JavaScript regex source matched against the whole tag name; MX anchors it
   * (`^(?:pattern)$`, no flags). Omitted, the entry matches every name.
   */
  pattern?: string;
  /** The tag whose whole contract validates the child, and its canonical name. */
  contract?: string;
  /** Inline contract: the child's attributes. */
  attributes?: Record<string, CustomTagAttribute>;
  /** Inline contract: the child's attribute tags. */
  attributeTags?: Record<string, CustomTagAttributeTag>;
  /** Inline contract: the child's own children. */
  children?: CustomTagChildren;
  /** Inline contract: the unnamed tag inside the child (decision 145). */
  defaultTag?: string;
}

/** `children["*"]`: one entry, or a list tried in declaration order. */
export type WildcardChildren =
  | WildcardChildEntry
  | readonly WildcardChildEntry[];

/**
 * A closed `children` record (contract extension E2): explicit names (and
 * `#text`), plus the optional `"*"` entries for names no explicit entry, no
 * built-in and no custom tag claims (decision 147). Explicit entries win.
 */
export interface CustomTagChildren {
  [name: string]: CustomTagChild | WildcardChildren | undefined;
  "*"?: WildcardChildren;
}

/** Authored direct children, before transforms or host lowering change them. */
export type ChildNode =
  | {
      kind: "ChildTag";
      /** The tag's name; the canonical name for a wildcard child. */
      name: string;
      loc: Position;
      hint?: string;
      /** How a wildcard child was written (decision 147). */
      alias?: TagAlias;
      /** Why no wildcard entry may claim this name: a built-in or a registered tag. */
      known?: "built-in" | "registered";
    }
  | { kind: "ChildText"; loc: Position }
  | { kind: "ChildDynamic"; loc: Position }
  | { kind: "ChildFor"; nodes: ChildNode[]; loc: Position }
  | {
      kind: "ChildIf";
      branches: Array<{ unconditional: boolean; nodes: ChildNode[] }>;
      loc: Position;
    };

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
  /**
   * Declares a name no tag states (a derived one, such as the `listId` a
   * `belongs-to` adds) in the declare phase, before any reference is checked
   * (decision 156 addendum 1, item 6). `span` is where an error or go-to for
   * the name points, normally the tag that caused it; `scope` names an
   * ancestor of that tag, defaulting to the file's root tag.
   */
  declare(
    kind: string,
    name: string,
    options: { span: SourceSpan; scope?: string | string[] },
  ): void;
}

/**
 * One thing a tag's contract declares (decision 156 addendum 1, items 4, 7, 10).
 * The tag's `name` (including `:name`) or its `#id` becomes a name of `kind`.
 */
export interface ContractDeclaration {
  /** A plain kind name; the same name in two contract modules is one kind. */
  kind: string;
  /** Where the name comes from: the `#id` sugar or the `name` attribute. */
  from: "id" | "name";
  /**
   * The nearest ancestor whose tag name is this one (or one of these) owns the
   * declaration; default the root tag. No such ancestor is a positioned error.
   */
  scope?: string | string[];
  /** Also clash with a same-named declaration of these kinds in the scope. */
  uniqueWith?: string[];
  /** Applies only under this parent tag (or one of these). No `under` means any parent. */
  under?: string | string[];
}

export interface FinalizeContext {
  store: TagStore;
  build: IrBuilders;
  gensym(hint?: string): string;
}

/** One call site: resolved IR plus optional authored-child syntax metadata. */
export interface TagCall {
  name: string;
  loc: Position;
  attrs: Attr[];
  /** UTF-16 span of the tag name at the call site, when the call has source. */
  nameSpan?: SourceSpan;
  /**
   * How the call was written, when a parent's `children["*"]` matched it
   * (decision 147): `name` is then the canonical tag.
   */
  alias?: TagAlias;
  /** UTF-16 span of the whole call, body and closing tag included. */
  span?: SourceSpan;
  content: Block | null;
  /** Authored child names/text and transparent control flow; not emitted IR. */
  childTree?: ChildNode[];
  attributeTags: AttributeTag[];
  /** Preserved control-flow shape for a template-backed component call. */
  attributeTagTree?: AttributeTagNode[];
  /** Callee-aware property plan for a template-backed component call. */
  attrTagProps?: AttrTagProp[];
  params: string[];
  var: string | null;
}

function directAttributeTagTree(
  tags: readonly AttributeTag[],
): AttributeTagNode[] {
  return tags.map((tag) => ({ kind: "AttributeTag", tag, loc: tag.loc }));
}

/** Copies control-flow containers while retaining attribute-tag identities. */
function cloneAttributeTagTree(
  nodes: readonly AttributeTagNode[],
): AttributeTagNode[] {
  return nodes.map((node) => {
    if (node.kind === "AttributeTag") return { ...node };
    if (node.kind === "AttributeTagIf") {
      return {
        ...node,
        branches: node.branches.map((branch) => ({
          ...branch,
          nodes: cloneAttributeTagTree(branch.nodes),
        })),
      };
    }
    return { ...node, nodes: cloneAttributeTagTree(node.nodes) };
  });
}

function filterAttributeTagTree(
  nodes: readonly AttributeTagNode[],
  remaining: Map<AttributeTag, number>,
  kept: Map<AttributeTag, number>,
): AttributeTagNode[] {
  const filtered: AttributeTagNode[] = [];
  for (const node of nodes) {
    if (node.kind === "AttributeTag") {
      const count = remaining.get(node.tag) ?? 0;
      if (count > 0) {
        remaining.set(node.tag, count - 1);
        kept.set(node.tag, (kept.get(node.tag) ?? 0) + 1);
        filtered.push(node);
      }
      continue;
    }
    if (node.kind === "AttributeTagIf") {
      const branches = node.branches.flatMap((branch) => {
        const nested = filterAttributeTagTree(branch.nodes, remaining, kept);
        return nested.length === 0 ? [] : [{ ...branch, nodes: nested }];
      });
      if (branches.length > 0) filtered.push({ ...node, branches });
      continue;
    }
    const nested = filterAttributeTagTree(node.nodes, remaining, kept);
    if (nested.length > 0) filtered.push({ ...node, nodes: nested });
  }
  return filtered;
}

/** Shared path cardinality for attribute tags and authored plain children. */
function attributeTagOccurrenceRange(
  nodes: readonly (AttributeTagNode | ChildNode)[],
  name: string,
): { min: number; max: number; inFor: boolean } {
  let min = 0;
  let max = 0;
  let inFor = false;
  for (const node of nodes) {
    if (
      node.kind === "AttributeTag" ||
      node.kind === "ChildTag" ||
      node.kind === "ChildText"
    ) {
      const childName =
        node.kind === "AttributeTag"
          ? node.tag.name
          : node.kind === "ChildTag"
            ? node.name
            : "#text";
      if (childName === name) {
        min++;
        max++;
      }
      continue;
    }
    if (node.kind === "ChildDynamic") continue;
    if (node.kind === "AttributeTagFor" || node.kind === "ChildFor") {
      const inner = attributeTagOccurrenceRange(node.nodes, name);
      if (inner.max > 0) {
        inFor = true;
        max = Number.POSITIVE_INFINITY;
      }
      continue;
    }
    const ranges = node.branches.map((branch) =>
      attributeTagOccurrenceRange(branch.nodes, name),
    );
    const exhaustive =
      node.kind === "AttributeTagIf"
        ? node.branches.some((branch) => branch.test === undefined)
        : node.branches.some((branch) => branch.unconditional);
    if (!exhaustive) ranges.push({ min: 0, max: 0, inFor: false });
    min += Math.min(...ranges.map((range) => range.min));
    max += Math.max(...ranges.map((range) => range.max));
    inFor ||= ranges.some((range) => range.inFor);
  }
  return { min, max, inFor };
}

function filterAttributeTagTreeByName(
  nodes: readonly AttributeTagNode[],
  name: string,
): AttributeTagNode[] {
  const filtered: AttributeTagNode[] = [];
  for (const node of nodes) {
    if (node.kind === "AttributeTag") {
      if (node.tag.name === name) filtered.push(node);
      continue;
    }
    if (node.kind === "AttributeTagIf") {
      const branches = node.branches.map((branch) => ({
        ...branch,
        nodes: filterAttributeTagTreeByName(branch.nodes, name),
      }));
      if (branches.some((branch) => branch.nodes.length > 0)) {
        filtered.push({ ...node, branches });
      }
      continue;
    }
    const nested = filterAttributeTagTreeByName(node.nodes, name);
    if (nested.length > 0) filtered.push({ ...node, nodes: nested });
  }
  return filtered;
}

function rebuildAttributeTagPlan(
  owner: string,
  originalTree: readonly AttributeTagNode[],
  originalProps: readonly AttrTagProp[],
  tags: readonly AttributeTag[],
): Pick<TagCall, "attributeTagTree" | "attrTagProps"> {
  const remaining = new Map<AttributeTag, number>();
  for (const tag of tags) remaining.set(tag, (remaining.get(tag) ?? 0) + 1);
  const kept = new Map<AttributeTag, number>();
  const attributeTagTree = filterAttributeTagTree(
    originalTree,
    remaining,
    kept,
  );

  // Objects absent from the authored tree were created by the transform and
  // have no control-flow provenance, so route them as unconditional siblings.
  for (const tag of tags) {
    const count = kept.get(tag) ?? 0;
    if (count > 0) {
      kept.set(tag, count - 1);
    } else {
      attributeTagTree.push({ kind: "AttributeTag", tag, loc: tag.loc });
    }
  }
  unifyNestedAttrTagPlanGroups(tags);

  const declarations = new Map(
    originalProps
      .filter(({ declared }) => declared)
      .map(({ name, cardinality, as }) => [name, { cardinality, as }]),
  );
  const names = [...new Set(tags.map((tag) => tag.name))];
  const attrTagProps = names.map((name): AttrTagProp => {
    const declaration = declarations.get(name);
    const range = attributeTagOccurrenceRange(attributeTagTree, name);
    if (declaration?.cardinality === "single") {
      const occurrences = tags.filter((tag) => tag.name === name);
      if (range.inFor) {
        failAt(
          owner,
          `\`<@${name}>\` may not appear inside \`<for>\` (\`${name}\` is declared \`AttrTag\`, not \`AttrTag[]\`)`,
          occurrences[0]?.loc ?? { line: 0, column: 0 },
        );
      }
      if (range.max > 1) {
        failAt(
          owner,
          `\`<@${name}>\` may appear at most once (\`${name}\` is declared \`AttrTag\`, not \`AttrTag[]\`)`,
          (occurrences[1] ?? occurrences[0])?.loc ?? { line: 0, column: 0 },
        );
      }
    }
    return {
      name,
      cardinality:
        declaration?.cardinality ??
        (range.max <= 1 && !range.inFor ? "single" : "array"),
      as: declaration?.as ?? fallbackAttrTagShape(tags, name),
      source: filterAttributeTagTreeByName(attributeTagTree, name),
    };
  });
  return { attributeTagTree, attrTagProps };
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
  /**
   * What an unnamed tag (`<#id>`, `<.class>`) directly inside this tag stands
   * for (decision 145): the parent contract, the top rung of the ladder. A
   * tag that is a reachable, plain-parsing tag of the target; the registry
   * checks it, and a host that forbids per-tag default tags refuses it.
   */
  defaultTag?: string;
  parseOptions?: CustomTagParseOptions;
  attributes?: Record<string, CustomTagAttribute>;
  attributeTags?: Record<string, CustomTagAttributeTag>;
  /**
   * Closed allowed authored children; `#text` permits non-whitespace text and
   * interpolations, and `"*"` accepts undeclared names (decision 147).
   */
  children?: CustomTagChildren;
  /** Allowed authored direct parents; `#root` is a unit's top level and `@name` an attribute tag. */
  parents?: string[];
  /**
   * The names this tag declares for atom references (decision 156). One entry
   * or an array; the most specific entry whose `under` matches the parent wins,
   * else the entry without `under`.
   */
  declares?: ContractDeclaration | ContractDeclaration[];
  analyze?(calls: readonly TagCall[], ctx: AnalyzeContext): void;
  transform?(call: TagCall, ctx: TransformContext): IrNode[] | TagCall;
  finalize?(ctx: FinalizeContext): IrNode[];
}

/** Default export of a package-level `mx.contracts` module (decision 142). */
export type ContractMap = Record<string, CustomTag>;

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
  /**
   * Requests a primitive from the active host without exposing that host.
   * `attrs` are carried on the node as given; omitted means none.
   */
  delegatedTag(
    name: string,
    children: IrNode[],
    attributeTags: AttributeTag[],
    attrs?: Attr[],
  ): IrNode;
  /**
   * Routes this tag's own template (`tags/x.mx`) as an imported component.
   *
   * Available only to a tag that has a template beside it. It is what makes
   * L1 and L2 compose rather than compete: a sidecar's `transform` wins over
   * the template, and this is how that transform uses the template as raw
   * unit — validate or rewrite first, then `return ctx.build.template(call)`.
   *
   * A sidecar with no `transform` at all (a *declaration-only* sidecar, one
   * that adds `attributes` or `parseOptions`) needs no call: the template
   * still expands, now validated.
   */
  template(call: TagCall): IrNode[];
}

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
          // `openTagOnly` is enforced by the MX lowerer so a body produces a
          // positioned MX TranslateError rather than Marko's parser error.
        }
      : undefined;
    definitions[`<${name}>`] = parseOptions ? { parseOptions } : {};
  }
  return [parserTaglibId(customTags), definitions];
}

function syntheticExpr(code: string): Expr {
  return {
    code,
    shape: "other",
    // SAFETY: an `Expr`'s `node` is the Babel node the expression came from,
    // and this one has none — the code was synthesized, not parsed. Every
    // reader of `node` on an `Expr` checks it before use (position lookups,
    // `emit`, the mapping pass), which is what `shape: "other"` selects.
    node: null as unknown as Node,
  };
}

/**
 * A positioned custom-tag diagnostic, keeping the position's own file.
 *
 * `at.file` is forwarded rather than dropped: a call written *inside a tag
 * template* is lowered while that template's own unit is compiled, so its
 * position measures against the template's text. Losing the file reports the
 * template's line and column against the caller instead — the cross-file
 * position rule (`Position.file`) exists for exactly this case.
 */
function failAt(tagName: string, message: string, at: Position): never {
  return failForOwner(`\`<${tagName}>\``, message, at);
}

/** An already formatted owner chain, shared by contracts at every depth. */
function failForOwner(owner: string, message: string, at: Position): never {
  throw new TranslateError(`${owner}: ${message}`, at.line, at.column, at.file);
}

function buildersFor(
  loc: Position,
  ctx: Ctx,
  node: Node | null,
  tagName: string,
  definition: CustomTag,
  normalizeTemplateCall?: (call: TagCall) => TagCall,
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
    delegatedTag: (name, children, attributeTags, attrs = []) => {
      if (node === null) {
        return failAt(
          tagName,
          "`ctx.build.delegatedTag` is not available in `finalize`",
          loc,
        );
      }
      if (ctx.declarations.isDelegatedTag?.(name, ctx) !== true) {
        return failAt(
          tagName,
          `this host does not claim \`<${name}>\`, so a custom tag cannot emit one`,
          loc,
        );
      }
      const attributeTagTree = attributeTags.map((tag) => ({
        kind: "AttributeTag" as const,
        tag,
        loc: tag.loc,
      }));
      const attrTagProps = [
        ...new Set(attributeTags.map((tag) => tag.name)),
      ].map((attributeName) => ({
        name: attributeName,
        cardinality:
          attributeTags.filter((tag) => tag.name === attributeName).length > 1
            ? ("array" as const)
            : ("single" as const),
        as: "data" as const,
        source: attributeTagTree.filter(
          (item) => item.tag.name === attributeName,
        ),
      }));
      return {
        kind: "DelegatedTag",
        tag: {
          name,
          attrs,
          children,
          attributeTags,
          attributeTagTree,
          attrTagProps,
          params: [],
          var: null,
          data: ctx.declarations.resolveDelegatedTag?.(name, node, ctx),
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
      return routeTemplateCall(
        ctx,
        definition,
        normalizeTemplateCall?.(call) ?? call,
      );
    },
  };
}

interface LiteralValue {
  type: "string" | "number" | "boolean" | "atom";
  value: string | number | boolean;
}

function listEnum(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function literalValue(attr: Attr): LiteralValue | null {
  if (attr.kind === "static") {
    // The name sugar's `:name` is stringified for every contract but an atom
    // one (decision 156 addendum 6); an explicit `x=:a` stays an atom.
    return {
      type: attr.atom && !attr.sugar ? "atom" : "string",
      value: attr.value,
    };
  }
  if (attr.kind === "boolean") return { type: "boolean", value: true };
  if (attr.kind !== "dynamic") return null;

  switch (attr.value.node?.type) {
    case "StringLiteral":
      return {
        type: attr.value.node.extra?.mxAtom ? "atom" : "string",
        value: attr.value.node.value,
      };
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

/** The written type of an expression node, or `null` when it cannot be known. */
function nodeShape(node: Node | null | undefined): string | null {
  switch (node?.type) {
    case "StringLiteral":
      return node.extra?.mxAtom ? "atom" : "string";
    // A template literal, plain or interpolated, always produces a string.
    case "TemplateLiteral":
      return "string";
    case "NumericLiteral":
      return "number";
    case "BooleanLiteral":
      return "boolean";
    case "ArrayExpression":
      return "array";
    case "ObjectExpression":
      return "object";
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return "function";
    case "UnaryExpression":
      // `-1` is a `UnaryExpression` over a `NumericLiteral`.
      return node.operator === "-" && node.argument.type === "NumericLiteral"
        ? "number"
        : null;
    default:
      return null;
  }
}

/** The written type of an attribute's value, or `null` when it cannot be known. */
function attrShape(attr: Attr): string | null {
  if (attr.kind === "static")
    return attr.atom && !attr.sugar ? "atom" : "string";
  if (attr.kind === "boolean") return "boolean";
  if (attr.kind !== "dynamic" && attr.kind !== "bound") return null;
  return nodeShape(attr.value.node);
}

/**
 * Checks an `array` or `function` attribute against its written shape.
 *
 * Only what is written is knowable: a literal array, a function of any
 * spelling, or a scalar literal has a shape, while an identifier, call, member
 * or conditional does not and passes, which is the rule `string` and `number`
 * already follow. `items` checks each literal element of a literal array; a
 * non-literal element, a spread or a hole passes the same way.
 */
function checkCompositeAttr(
  owner: string,
  attr: Exclude<Attr, { kind: "spread" }>,
  declaration: CustomTagAttribute,
): void {
  const shape = attrShape(attr);
  if (shape && shape !== declaration.type) {
    failForOwner(
      owner,
      `attribute ${attrLabel(attr)} must be ${declaration.type}, got ${shape}`,
      attr.loc,
    );
  }
  if (
    declaration.type !== "array" ||
    !declaration.items ||
    (attr.kind !== "dynamic" && attr.kind !== "bound") ||
    attr.value.node?.type !== "ArrayExpression"
  ) {
    return;
  }
  const elements = attr.value.node.elements as Array<Node | null>;
  for (const [index, element] of elements.entries()) {
    const got = nodeShape(element);
    if (!element || !got || got === declaration.items) continue;
    const start = element.loc?.start;
    failForOwner(
      owner,
      `attribute ${attrLabel(attr)} item ${index + 1} must be ${declaration.items}, got ${got}`,
      start
        ? { ...attr.loc, line: start.line, column: start.column }
        : attr.loc,
    );
  }
}

/**
 * Checks an `atom` attribute against its written shape (decision 156): an atom
 * or a literal list of atoms. A string, a number or a function is a type error
 * at the offending value; an identifier, call, member or conditional has no
 * knowable type and passes. Which names are allowed is the file-level check's
 * business (`atom-contracts.ts`).
 */
function checkAtomAttr(
  owner: string,
  attr: Exclude<Attr, { kind: "spread" }>,
  locate?: Locate,
): void {
  // An atom, the sugar-derived `name` included, satisfies an atom contract.
  if (attr.kind === "static" && attr.atom) return;
  const shape = attrShape(attr);
  if (shape && shape !== "atom" && shape !== "array") {
    failForOwner(
      owner,
      `attribute ${attrLabel(attr)} must be atom, got ${shape}`,
      attr.loc,
    );
  }
  if (
    (attr.kind !== "dynamic" && attr.kind !== "bound") ||
    attr.value.node?.type !== "ArrayExpression"
  ) {
    return;
  }
  for (const element of attr.value.node.elements as Array<Node | null>) {
    const got = nodeShape(element);
    if (!element || !got || got === "atom") continue;
    const start = element.loc?.start;
    failForOwner(
      owner,
      `attribute ${attrLabel(attr)} must be atom, got ${got}`,
      start
        ? { ...attr.loc, line: start.line, column: start.column }
        : attr.loc,
    );
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
    // SAFETY: a Babel literal carries more than `type`/`value` (a position
    // among them), and this node is synthesized rather than parsed, so the
    // cast is the honest shape for a literal whose emitters read only these
    // two fields. It is never handed back to Marko.
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

/** Validates the authored direct parent before the call's body is lowered. */
export function validateCustomTagParents(
  definition: CustomTag,
  name: string,
  loc: Position,
  parent: string,
  label = `\`<${name}>\``,
): void {
  const parents = definition.parents;
  // A dynamic parent's diagnostic placeholder is not an authored name.
  if (!parents || (parent !== `\${…}` && parents.includes(parent))) return;
  const named = parents.filter((allowed) => allowed !== "#root");
  const inside = named.map((allowed) => `\`<${allowed}>\``).join(", ");
  const required = inside
    ? `inside ${inside}${parents.includes("#root") ? " or at the top level" : ""}`
    : parents.includes("#root")
      ? "at the top level"
      : "inside an allowed parent (none declared)";
  const found =
    parent === "#root" ? "at the top level" : `inside \`<${parent}>\``;
  throw new TranslateError(
    `${label} must be ${required}; found ${found}`,
    loc.line,
    loc.column,
    loc.file,
  );
}

/** Validates authored children before any plain child is lowered. */
export function validateCustomTagChildren(
  definition: Pick<CustomTag, "children">,
  call: Pick<TagCall, "name" | "loc" | "childTree">,
  owner = `\`<${call.name}>\``,
): void {
  if (!definition.children) return;
  const declarations = definition.children;
  const explicit = explicitChildEntries(declarations);
  const entries = wildcardEntries(declarations);
  const tree = call.childTree ?? [];
  const leaves: Array<Extract<ChildNode, { kind: "ChildTag" | "ChildText" }>> =
    [];
  const allowed =
    explicit.map(([name]) => `\`<${name}>\``).join(", ") || "none";
  // Check order (decision 147): an explicit entry, then the `"*"` entries in
  // order (the lowerer already matched them, recorded on the child), then the
  // closed record's own error.
  const notAllowed = (
    node: Extract<ChildNode, { kind: "ChildTag" }>,
  ): string => {
    const label = `\`<${node.name}>\``;
    const hint = node.hint ? ` ${node.hint}` : "";
    if (entries.length === 0) {
      return `${label} is not allowed here; allowed children: ${allowed}${hint}`;
    }
    const patterns = entries
      .flatMap((entry) =>
        entry.pattern === undefined ? [] : [`\`${entry.pattern}\``],
      )
      .join(" or ");
    const catchAll = entries.some((entry) => entry.pattern === undefined);
    const names = explicit.filter(([name]) => name !== "#text");
    const others = names.length > 0 ? "other names" : "names";
    const rule = patterns
      ? `${others} must match ${patterns}${catchAll ? ", or be a name that is not already a tag" : ""}`
      : `${others} must be a name that is not already a tag`;
    const known = node.known
      ? matchWildcardEntry(declarations, node.name)
        ? ` (${label} is ${node.known === "built-in" ? "a built-in tag" : "a registered tag"}, so the wildcard does not apply to it)`
        : ""
      : "";
    const listed =
      names.length > 0
        ? `allowed children: ${names.map(([name]) => `\`<${name}>\``).join(", ")}; `
        : "";
    return `${label} is not allowed here; ${listed}${rule}${known}${hint}`;
  };
  // What a text child is told the parent does accept; a wildcard entry means
  // tags are accepted even when no child is named.
  const textRule =
    entries.length > 0
      ? `it accepts only child tags: ${[
          ...explicit.flatMap(([name]) =>
            name === "#text" ? [] : [`\`<${name}>\``],
          ),
          ...entries.map((entry) =>
            entry.pattern === undefined
              ? "any other name"
              : `names matching \`${entry.pattern}\``,
          ),
        ].join(", ")}`
      : allowed === "none"
        ? "it accepts no child tags"
        : `it accepts only the child tags ${allowed}`;
  const collect = (nodes: readonly ChildNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "ChildFor") collect(node.nodes);
      else if (node.kind === "ChildIf") {
        for (const branch of node.branches) collect(branch.nodes);
      } else if (node.kind === "ChildDynamic") {
        failForOwner(
          owner,
          `a dynamic tag \`<\${…}>\` cannot be checked against the declared children`,
          node.loc,
        );
      } else {
        const name = node.kind === "ChildTag" ? node.name : "#text";
        const matched = node.kind === "ChildTag" && node.alias !== undefined;
        if (!matched && !hasExplicitChild(declarations, name)) {
          failForOwner(
            owner,
            node.kind === "ChildText"
              ? `text is not allowed here; ${textRule}`
              : notAllowed(node),
            node.loc,
          );
        }
        leaves.push(node);
      }
    }
  };
  collect(tree);
  // One identity per tag (ADR 147): a wildcard child counts under its
  // canonical name against that name's explicit entry.
  for (const [name, declaration] of explicit) {
    const range = attributeTagOccurrenceRange(tree, name);
    if (declaration.repeatable !== true && range.max > 1) {
      const occurrences = leaves.filter(
        (node) => (node.kind === "ChildTag" ? node.name : "#text") === name,
      );
      const repeated = occurrences[1] ?? occurrences[0];
      const label =
        repeated?.kind === "ChildTag"
          ? tagLabel(repeated.name, repeated.alias)
          : `\`<${name}>\``;
      failForOwner(
        owner,
        `${label} may not be repeated`,
        repeated?.loc ?? call.loc,
      );
    }
    if (declaration.required && range.min === 0) {
      failForOwner(owner, `missing required child \`<${name}>\``, call.loc);
    }
  }
}

/** Offset to line and column in the file being compiled. */
type Locate = (offset: number) => { line: number; column: number };

/** Where a value error points: at a whole-value atom when the offset can be located, else the attribute. */
function valueAt(attr: Attr, locate?: Locate): Position {
  if (attr.kind === "static" && attr.atom && locate) {
    return { ...attr.loc, ...locate(attr.atom.span.sourceStart) };
  }
  return attr.loc;
}

/** One attribute checker for top-level tags and every declared attribute tag. */
function validateAttributes(
  owner: string,
  attributes: CustomTag["attributes"],
  attrs: readonly Attr[],
  loc: Position,
  locate?: Locate,
): void {
  if (!attributes) return;
  // An empty closed contract rejects named and spread attributes identically.
  const acceptsNone = Object.keys(attributes).length === 0;
  const present = new Set<string>();
  for (const attr of attrs) {
    if (attr.kind === "spread") {
      failForOwner(
        owner,
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
      failForOwner(
        owner,
        acceptsNone
          ? "accepts no attributes"
          : `unknown attribute ${attrLabel(attr)}`,
        attr.loc,
      );
    }
    present.add(attr.name);
    const literal = literalValue(attr);
    if (declaration.literalOnly && !isLiteralAttr(attr)) {
      failForOwner(
        owner,
        `attribute ${attrLabel(attr)} must be a literal`,
        attr.loc,
      );
    }
    if (declaration.type === "atom") {
      checkAtomAttr(owner, attr, locate);
    } else if (
      declaration.type === "array" ||
      declaration.type === "function"
    ) {
      checkCompositeAttr(owner, attr, declaration);
    } else if (
      declaration.type &&
      declaration.type !== "expression" &&
      literal &&
      declaration.type !== literal.type
    ) {
      failForOwner(
        owner,
        `attribute ${attrLabel(attr)} must be ${declaration.type}, got ${literal.type}`,
        valueAt(attr, locate),
      );
    }
    if (
      declaration.type === "expression" &&
      ((attr.kind === "static" && !attr.atom) || attr.kind === "boolean")
    ) {
      failForOwner(
        owner,
        `attribute ${attrLabel(attr)} must be an expression`,
        attr.loc,
      );
    }
    if (declaration.enum) {
      if (!literal) {
        failForOwner(
          owner,
          `attribute ${attrLabel(attr)} must be a static value from ${listEnum(declaration.enum)}`,
          attr.loc,
        );
      }
      // Enum members are strings: no coercion of booleans or numbers.
      const enumType = declaration.type ?? "string";
      if (
        enumType !== "string" ||
        literal.type !== "string" ||
        typeof literal.value !== "string"
      ) {
        failForOwner(
          owner,
          `attribute ${attrLabel(attr)} must be a string from ${listEnum(declaration.enum)}, got ${literal.type}`,
          attr.loc,
        );
      }
      if (!declaration.enum.includes(literal.value)) {
        failForOwner(
          owner,
          `attribute ${attrLabel(attr)} must be one of ${listEnum(declaration.enum)}, got ${JSON.stringify(literal.value)}`,
          attr.loc,
        );
      }
    }
  }
  for (const [name, declaration] of Object.entries(attributes)) {
    if (declaration.required && !present.has(name)) {
      failForOwner(owner, `missing required attribute \`${name}\``, loc);
    }
  }
}

/** Whether this declaration opts into recursive contracts rather than legacy body-only rules. */
export function hasAttributeTagContract(
  declaration: CustomTagAttributeTag | undefined,
): boolean {
  return (
    declaration !== undefined &&
    (declaration.attributes !== undefined ||
      declaration.attributeTags !== undefined ||
      declaration.children !== undefined)
  );
}

function validateAttributeTags(
  owner: string,
  declaredTags: CustomTag["attributeTags"],
  tags: readonly AttributeTag[],
  tree: readonly AttributeTagNode[],
  loc: Position,
  allowUncontractedTags: boolean,
): void {
  for (const tag of tags) {
    const declaration =
      declaredTags && Object.hasOwn(declaredTags, tag.name)
        ? declaredTags[tag.name]
        : undefined;
    const extended = hasAttributeTagContract(declaration);
    if (!allowUncontractedTags && !extended) {
      if (tag.attrs.length > 0) {
        failForOwner(
          owner,
          `attribute tag \`<@${tag.name}>\` does not support attributes`,
          tag.attrs[0]?.loc ?? tag.loc,
        );
      }
      if (tag.attributeTags.length > 0) {
        failForOwner(
          owner,
          `attribute tag \`<@${tag.name}>\` does not support nested attribute tags`,
          tag.attributeTags[0]?.loc ?? tag.loc,
        );
      }
    }
    if (declaredTags && !declaration) {
      failForOwner(owner, `unknown attribute tag \`<@${tag.name}>\``, tag.loc);
    }
    if (declaration) {
      const nestedOwner = `${owner}: \`<@${tag.name}>\``;
      validateAttributes(
        nestedOwner,
        declaration.attributes,
        tag.attrs,
        tag.loc,
      );
      validateAttributeTags(
        nestedOwner,
        declaration.attributeTags,
        tag.attributeTags,
        tag.attributeTagTree,
        tag.loc,
        allowUncontractedTags ||
          (extended && declaration.attributeTags === undefined),
      );
    }
  }
  for (const [name, declaration] of Object.entries(declaredTags ?? {})) {
    const range = attributeTagOccurrenceRange(tree, name);
    if (declaration.repeatable !== true && range.max > 1) {
      const occurrences = tags.filter((tag) => tag.name === name);
      failForOwner(
        owner,
        `attribute tag \`<@${name}>\` may not be repeated`,
        occurrences[1]?.loc ?? occurrences[0]?.loc ?? loc,
      );
    }
    if (declaration.required && range.min === 0) {
      failForOwner(owner, `missing required attribute tag \`<@${name}>\``, loc);
    }
  }
}

/** Enforces a tag's declared contracts before its transform runs. */
export function validateCustomTagCall(
  definition: CustomTag,
  call: TagCall,
  locate?: Locate,
): void {
  const owner = tagLabel(call.name, call.alias);
  validateCustomTagChildren(definition, call, owner);
  if (definition.parseOptions?.openTagOnly && call.content) {
    failForOwner(owner, "does not accept content", call.loc);
  }
  validateAttributes(
    owner,
    definition.attributes,
    call.attrs,
    call.loc,
    locate,
  );
  validateAttributeTags(
    owner,
    definition.attributeTags,
    call.attributeTags,
    call.attributeTagTree ?? directAttributeTagTree(call.attributeTags),
    call.loc,
    hasTemplate(definition),
  );
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
  "items",
  "required",
  "enum",
  "default",
  "literalOnly",
  "values",
  "pattern",
  "ref",
] as const;
const CHILD_KEYS = ["repeatable", "required"] as const;
const ATTRIBUTE_TAG_KEYS = [
  ...CHILD_KEYS,
  "attributes",
  "attributeTags",
  "children",
  "defaultTag",
] as const;

const ITEM_TYPES = ["string", "number", "boolean"] as const;

/** A non-empty string, or a non-empty array of them. */
function nonEmptyStrings(value: unknown): boolean {
  const ok = (item: unknown) => typeof item === "string" && item !== "";
  return Array.isArray(value) ? value.length > 0 && value.every(ok) : ok(value);
}

const DECLARES_KEYS = ["kind", "from", "scope", "uniqueWith", "under"] as const;

/** Rejects a malformed `declares` at registration, naming the tag and the entry. */
function rejectInvalidDeclares(tagName: string, definition: CustomTag): void {
  if (definition.declares === undefined) return;
  const entries: unknown[] = Array.isArray(definition.declares)
    ? definition.declares
    : [definition.declares];
  const reject = (problem: string): never => {
    throw new TranslateError(
      `Invalid \`declares\` of tag "${tagName}": ${problem}`,
      0,
      0,
    );
  };
  if (entries.length === 0) reject("it has no entries");
  for (const entry of entries as Array<Record<string, unknown>>) {
    if (typeof entry !== "object" || entry === null) {
      reject("each entry must be an object");
    }
    for (const key of Object.keys(entry)) {
      if (!(DECLARES_KEYS as readonly string[]).includes(key)) {
        reject(`unknown key "${key}"; allowed: ${DECLARES_KEYS.join(", ")}`);
      }
    }
    if (typeof entry.kind !== "string" || entry.kind === "") {
      reject("`kind` must be a non-empty kind name");
    }
    if (entry.from !== "id" && entry.from !== "name") {
      reject('`from` must be "id" or "name"');
    }
    for (const key of ["scope", "under"] as const) {
      if (entry[key] !== undefined && !nonEmptyStrings(entry[key])) {
        reject(`\`${key}\` must be a tag name or an array of tag names`);
      }
    }
    if (
      entry.uniqueWith !== undefined &&
      !(Array.isArray(entry.uniqueWith) && nonEmptyStrings(entry.uniqueWith))
    ) {
      reject("`uniqueWith` must be an array of kind names");
    }
  }
}

/** Rejects a declaration whose keys contradict each other, at registration. */
function rejectContradictoryAttribute(
  owner: string,
  attrName: string,
  declaration: CustomTagAttribute,
): void {
  const reject = (problem: string): never => {
    throw new TranslateError(
      `Invalid "${attrName}" attribute declaration of ${owner}: ${problem}`,
      0,
      0,
    );
  };
  if (declaration.items !== undefined) {
    if (declaration.type !== "array") {
      reject('`items` requires `type: "array"`');
    }
    if (!(ITEM_TYPES as readonly unknown[]).includes(declaration.items)) {
      reject(`\`items\` must be one of ${ITEM_TYPES.join(", ")}`);
    }
  }
  for (const key of ["values", "pattern", "ref"] as const) {
    if (declaration[key] !== undefined && declaration.type !== "atom") {
      reject(`\`${key}\` requires \`type: "atom"\``);
    }
  }
  if (declaration.type === "atom") {
    if (declaration.enum !== undefined) {
      reject('`enum` cannot be combined with `type: "atom"`; use `values`');
    }
    if (
      declaration.values !== undefined &&
      !(
        Array.isArray(declaration.values) &&
        declaration.values.every((value) => typeof value === "string")
      )
    ) {
      reject("`values` must be an array of strings");
    }
    if (declaration.pattern !== undefined) {
      try {
        if (typeof declaration.pattern !== "string") throw new TypeError();
        new RegExp(declaration.pattern);
      } catch {
        reject("`pattern` must be a valid regular expression source string");
      }
    }
    if (declaration.ref !== undefined && !nonEmptyStrings(declaration.ref)) {
      reject("`ref` must be a kind name or an array of kind names");
    }
  }
  if (
    declaration.enum &&
    (declaration.type === "array" || declaration.type === "function")
  ) {
    reject(`\`enum\` cannot be combined with \`type: "${declaration.type}"\``);
  }
}

/**
 * Rejects an unknown key in a registered tag's attribute, attribute-tag or child
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
    if (definition.children !== undefined) {
      for (const option of ["text", "openTagOnly"] as const) {
        if (definition.parseOptions?.[option] === true) {
          failAt(
            tagName,
            `\`children\` cannot be combined with \`parseOptions.${option}: true\``,
            { line: 0, column: 0 },
          );
        }
      }
      for (const [childName, declaration] of explicitChildEntries(
        definition.children,
      )) {
        const child =
          childName !== "#text" && Object.hasOwn(customTags, childName)
            ? customTags[childName]
            : undefined;
        if (child?.parents !== undefined && !child.parents.includes(tagName)) {
          failAt(
            tagName,
            `child \`<${childName}>\` declares \`parents\` without \`<${tagName}>\`; add \`<${tagName}>\` to \`<${childName}>\`'s \`parents\`, or remove \`<${childName}>\` from \`<${tagName}>\`'s \`children\``,
            { line: 0, column: 0 },
          );
        }
        for (const key of Object.keys(declaration)) {
          if (!(CHILD_KEYS as readonly string[]).includes(key)) {
            throw new TranslateError(
              `Unknown key "${key}" in the "${childName}" child declaration of tag "${tagName}"; allowed: ${CHILD_KEYS.join(", ")}`,
              0,
              0,
            );
          }
        }
      }
    }
    for (const parentName of definition.parents ?? []) {
      const parent =
        parentName !== "#root" && Object.hasOwn(customTags, parentName)
          ? customTags[parentName]
          : undefined;
      if (
        parent?.children !== undefined &&
        !hasExplicitChild(parent.children, tagName) &&
        !wildcardReferences(parent.children, tagName)
      ) {
        failAt(
          tagName,
          `parent \`<${parentName}>\` declares \`children\` without \`<${tagName}>\`; add \`<${tagName}>\` to \`<${parentName}>\`'s \`children\`, or remove \`<${parentName}>\` from \`<${tagName}>\`'s \`parents\``,
          { line: 0, column: 0 },
        );
      }
    }
    rejectNonStringDefaultTag(`\`<${tagName}>\``, definition);
    rejectInvalidDeclares(tagName, definition);
    rejectRecursiveContractKeys(
      `tag "${tagName}"`,
      definition,
      `\`<${tagName}>\``,
    );
  }
  for (const [tagName, definition] of Object.entries(customTags)) {
    rejectAttributeTagParentConflicts(
      customTags,
      `\`<${tagName}>\``,
      definition.attributeTags,
    );
  }
}

/** Cross-check every attribute-tag owner, including duplicate names at any depth. */
function rejectAttributeTagParentConflicts(
  customTags: Readonly<Record<string, CustomTag>>,
  owner: string,
  declarations: CustomTag["attributeTags"],
): void {
  for (const [name, declaration] of Object.entries(declarations ?? {})) {
    const parentName = `@${name}`;
    const parentLabel = `\`<${parentName}>\``;
    const nestedOwner = `${owner}: ${parentLabel}`;
    if (declaration.children !== undefined) {
      for (const [childName] of explicitChildEntries(declaration.children)) {
        const child =
          childName !== "#text" && Object.hasOwn(customTags, childName)
            ? customTags[childName]
            : undefined;
        if (
          child?.parents !== undefined &&
          !child.parents.includes(parentName)
        ) {
          failForOwner(
            nestedOwner,
            `child \`<${childName}>\` declares \`parents\` without ${parentLabel}; add ${parentLabel} to \`<${childName}>\`'s \`parents\`, or remove \`<${childName}>\` from ${nestedOwner}'s \`children\``,
            { line: 0, column: 0 },
          );
        }
      }
      for (const [childName, child] of Object.entries(customTags)) {
        if (
          child.parents?.includes(parentName) &&
          !hasExplicitChild(declaration.children, childName) &&
          !wildcardReferences(declaration.children, childName)
        ) {
          failAt(
            childName,
            `parent ${nestedOwner} declares \`children\` without \`<${childName}>\`; add \`<${childName}>\` to ${nestedOwner}'s \`children\`, or remove ${parentLabel} from \`<${childName}>\`'s \`parents\``,
            { line: 0, column: 0 },
          );
        }
      }
    }
    rejectAttributeTagParentConflicts(
      customTags,
      nestedOwner,
      declaration.attributeTags,
    );
  }
}

/** `defaultTag` is a tag name: any other type is a registration error at the declaration. */
function rejectNonStringDefaultTag(
  owner: string,
  declaration: { defaultTag?: unknown },
): void {
  const value = declaration.defaultTag;
  if (value === undefined) return;
  if (typeof value === "string" && value !== "") return;
  const found =
    value === ""
      ? "an empty string"
      : value === null
        ? "null"
        : Array.isArray(value)
          ? "an array"
          : typeof value === "object"
            ? "an object"
            : `a ${typeof value}`;
  throw new TranslateError(
    `${owner}: \`defaultTag\` must be a tag name string, got ${found}`,
    0,
    0,
  );
}

/** Registration uses the same key vocabulary at every attribute-tag depth. */
function rejectRecursiveContractKeys(
  owner: string,
  definition: Pick<CustomTag, "attributes" | "attributeTags" | "children">,
  label = owner,
  root = label,
  path: Set<object> = new Set([definition]),
): void {
  const keys = (
    declaration: object,
    allowed: readonly string[],
    description: string,
  ): void => {
    for (const key of Object.keys(declaration)) {
      if (!allowed.includes(key)) {
        throw new TranslateError(
          `Unknown key "${key}" in the ${description} of ${owner}; allowed: ${allowed.join(", ")}`,
          0,
          0,
        );
      }
    }
  };
  const fail: (message: string) => never = (message) => {
    throw new TranslateError(message, 0, 0);
  };
  for (const [attrName, declaration] of Object.entries(
    definition.attributes ?? {},
  )) {
    keys(declaration, ATTRIBUTE_KEYS, `"${attrName}" attribute declaration`);
    rejectContradictoryAttribute(owner, attrName, declaration);
  }
  for (const [childName, declaration] of explicitChildEntries(
    definition.children,
  )) {
    keys(declaration, CHILD_KEYS, `"${childName}" child declaration`);
  }
  if (definition.children && Object.hasOwn(definition.children, WILDCARD)) {
    const value: unknown = definition.children[WILDCARD];
    if (value === null || typeof value !== "object") {
      fail(
        `${label}: \`children["*"]\` must be an entry object or a list of entry objects`,
      );
    }
    const entries = Array.isArray(value) ? value : [value];
    entries.forEach((entry: unknown, index) => {
      const at = `\`children["*"]\` entry ${index + 1}`;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        fail(`${label}: ${at} must be an object`);
      }
      const declared = entry as WildcardChildEntry;
      keys(declared, WILDCARD_ENTRY_KEYS, at);
      if (declared.pattern !== undefined) {
        if (typeof declared.pattern !== "string") {
          fail(`${label}: ${at}: \`pattern\` must be a string`);
        }
        try {
          entryRegExp(declared);
        } catch (error) {
          fail(
            `${label}: ${at} has an invalid \`pattern\` ${JSON.stringify(declared.pattern)}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const inline = INLINE_CONTRACT_KEYS.filter((key) =>
        Object.hasOwn(declared, key),
      );
      if (declared.contract !== undefined) {
        if (typeof declared.contract !== "string" || declared.contract === "") {
          fail(`${label}: ${at}: \`contract\` must be a non-empty tag name`);
        }
        if (inline.length > 0) {
          fail(
            `${label}: ${at} has both \`contract\` and an inline contract (${inline.map((key) => `\`${key}\``).join(", ")}); use one`,
          );
        }
        return;
      }
      // An inline contract is a declaration like any other, at any depth. A
      // reference by name always terminates (each authored child resolves
      // against its own parent), but an inline object that contains itself
      // never finishes being read: the one cycle registration must refuse.
      if (path.has(declared)) {
        fail(
          `${root}: \`children["*"]\` holds an inline contract that contains itself; declare it as a tag and refer to it with \`contract\``,
        );
      }
      rejectNonStringDefaultTag(`${label}: ${at}`, declared);
      path.add(declared);
      rejectRecursiveContractKeys(
        `${owner}: ${at}`,
        declared,
        `${label}: ${at}`,
        root,
        path,
      );
      path.delete(declared);
    });
  }
  for (const [name, declaration] of Object.entries(
    definition.attributeTags ?? {},
  )) {
    keys(
      declaration,
      ATTRIBUTE_TAG_KEYS,
      `"${name}" attribute tag declaration`,
    );
    rejectNonStringDefaultTag(`${owner}: \`<@${name}>\``, declaration);
    if (path.has(declaration)) {
      fail(
        `${label}: \`<@${name}>\`: an attribute-tag declaration contains itself`,
      );
    }
    path.add(declaration);
    rejectRecursiveContractKeys(
      `${owner}: "<@${name}>"`,
      declaration,
      `${label}: \`<@${name}>\``,
      root,
      path,
    );
    path.delete(declaration);
  }
}

/** Whether a `children` record's wildcard entries reference `tagName` by `contract`. */
function wildcardReferences(
  children: CustomTagChildren | undefined,
  tagName: string,
): boolean {
  return wildcardEntries(children).some((entry) => entry.contract === tagName);
}

/**
 * The merged-map checks of `children["*"]` (decision 147): every `contract`
 * names a tag this compile can reach, that tag's parse options do not need
 * the name it is written with, and its `parents` admit the parent. Runs on the
 * whole map a compile receives, never per sidecar or per module, where a
 * reference to another file's tag would look unreachable.
 */
export function rejectWildcardReferences(
  customTags: Readonly<Record<string, CustomTag>> | undefined,
): void {
  if (!customTags) return;
  const fail: (message: string) => never = (message) => {
    throw new TranslateError(message, 0, 0);
  };
  const visit = (
    label: string,
    declaration: Pick<CustomTag, "attributeTags" | "children">,
    parentName: string | undefined,
    seen: Set<object>,
  ): void => {
    if (seen.has(declaration)) return;
    seen.add(declaration);
    wildcardEntries(declaration.children).forEach((entry, index) => {
      const at = `\`children["*"]\` entry ${index + 1}`;
      if (entry.contract === undefined) {
        visit(`${label}: ${at}`, entry, undefined, seen);
        return;
      }
      const referenced = Object.hasOwn(customTags, entry.contract)
        ? customTags[entry.contract]
        : undefined;
      if (!referenced) {
        fail(
          `${label}: ${at} references \`contract: ${JSON.stringify(entry.contract)}\`, which is not a tag reachable from this compile`,
        );
      }
      for (const option of ["text", "preserveWhitespace"] as const) {
        if (referenced.parseOptions?.[option] === true) {
          fail(
            `${label}: ${at} references \`<${entry.contract}>\`, which sets \`parseOptions.${option}\`; parse options apply to the name as written, before the wildcard resolves it`,
          );
        }
      }
      if (
        parentName !== undefined &&
        referenced.parents !== undefined &&
        !referenced.parents.includes(parentName)
      ) {
        fail(
          `${label}: \`children["*"]\` references \`<${entry.contract}>\`, which declares \`parents\` without \`<${parentName}>\`; add \`<${parentName}>\` to \`<${entry.contract}>\`'s \`parents\`, or remove the reference`,
        );
      }
    });
    for (const [name, nested] of Object.entries(
      declaration.attributeTags ?? {},
    )) {
      visit(`${label}: \`<@${name}>\``, nested, `@${name}`, seen);
    }
  };
  for (const [tagName, definition] of Object.entries(customTags)) {
    visit(`\`<${tagName}>\``, definition, tagName, new Set());
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
      declare: (kind, declaredName, options) => {
        ctx.contractDerived ??= [];
        ctx.contractDerived.push({
          kind,
          name: declaredName,
          span: options.span,
          scope: options.scope,
        });
      },
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
): TranslateError {
  if (isTranslateError(error)) return error;
  return new TranslateError(
    `\`<${tagName}>\`: custom tag \`${hook}\` threw: ${error instanceof Error ? error.message : String(error)}`,
    loc.line,
    loc.column,
    loc.file,
  );
}

/** The per-file hygienic name generator, shared by every context that has one. */
function gensymFor(ctx: Ctx, tagName: string, hint?: string): string {
  const serial = ++ctx.customTagGensym.n;
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

/**
 * Whether a call of this definition hands its validated call to the host.
 *
 * The definition must be contract-only: it has neither a `transform` nor a
 * template. Whatever else it declares counts, `{}` included: an empty
 * declaration is a contract for a tag with no attributes and no body rules.
 * The one question core asks the host is the generic `isDelegatedTag`; on a
 * target that does not claim the name, such a definition keeps the "neither a
 * `transform` nor a template" error.
 */
export function isContractOnlyDelegated(
  ctx: Ctx,
  name: string,
  definition: CustomTag,
): boolean {
  return (
    !definition.transform &&
    !hasTemplate(definition) &&
    ctx.declarations.isDelegatedTag?.(name, ctx) === true
  );
}

/**
 * The `DelegatedTag` a validated contract-only call lowers to. It is the node an
 * unregistered claimed tag produces (same body, same attributes), except that
 * the call is validated against its contract and declared defaults are added.
 * With `openTagOnly`, a whitespace-only body is rejected (positioned), while
 * a `transform` tag accepts it; this is intentional and stricter.
 * Validation also rejects what the contract-only path cannot carry, which an
 * unregistered claimed tag accepts: `/var` ("`/var` on `<tag>` is not
 * supported: it has no template, so it has no `<return>` to bind"), tag
 * arguments ("tag arguments `(...)` on `<tag>` are not supported in a
 * standalone template"), and attributes or nested attribute tags on an attribute tag
 * ("`<tag>`: attribute tag `<@x>` does not support attributes" / "does not
 * support nested attribute tags").
 */
function contractOnlyDelegatedTag(ctx: Ctx, call: TagCall, node: Node): IrNode {
  return {
    kind: "DelegatedTag",
    tag: {
      name: call.name,
      ...(call.alias ? { alias: call.alias } : {}),
      nameSpan: call.nameSpan,
      span: call.span,
      attrs: call.attrs,
      args: [],
      children: call.content?.children ?? [],
      attributeTags: call.attributeTags,
      attributeTagTree:
        call.attributeTagTree ?? directAttributeTagTree(call.attributeTags),
      attrTagProps: call.attrTagProps ?? [],
      params: call.params,
      var: call.var,
      data: ctx.declarations.resolveDelegatedTag?.(call.name, node, ctx),
      loc: call.loc,
    },
    loc: call.loc,
  };
}

/** Runs a validated transform and normalizes its failures to TranslateError. */
export function transformCustomTag(
  ctx: Ctx,
  definition: CustomTag,
  call: TagCall,
  node: Node,
): IrNode[] {
  // Decision 130: a contract-only tag (no `transform`, no template) is valid
  // on a name the active host claims; anywhere else a call has nothing to
  // expand to.
  const contractOnly = isContractOnlyDelegated(ctx, call.name, definition);
  const owner = tagLabel(call.name, call.alias);
  if (!definition.transform && !hasTemplate(definition) && !contractOnly) {
    // An inline `children["*"]` contract can carry no transform: it is
    // validation-only, useful where the target delegates (data).
    const inline =
      call.alias !== undefined && call.alias.authored === call.name;
    failForOwner(
      owner,
      inline
        ? `an inline \`children["*"]\` contract has no transform; on ${ctx.declarations.name ?? "this target"} a matched child needs \`contract:\` naming a tag with a transform or template`
        : "custom tag has neither a `transform` nor a template file, so a call has nothing to expand to",
      call.loc,
    );
  }

  validateCustomTagCall(definition, call, (offset) => positionAt(ctx, offset));
  // Decision 156: remembered for the file-level declare and check phases.
  ctx.contractFacts ??= new Map();
  ctx.contractFacts.set(node, {
    definition,
    call,
    chain: [...(ctx.authoredAncestorNodes ?? [])],
  });
  const withDefaults: TagCall = {
    ...call,
    attrs: applyCustomTagDefaults(definition, call),
  };

  // The analyze pre-pass. Validation above has already run, so a bad call is
  // reported once at its real position rather than twice or (worse) only on
  // the second walk; from here the call is merely recorded and expands to
  // nothing, because its `transform` must not run until every `analyze` in
  // the file has seen every call. Calls inside a template belong to that
  // template's own compilation unit and are not replayed into its caller.
  const analyzePass = ctx.customTagAnalyzePass;
  if (analyzePass) {
    const recorded = analyzePass.calls.get(call.name);
    if (recorded) {
      recorded.push(withDefaults);
    } else {
      analyzePass.calls.set(call.name, [withDefaults]);
    }
    return [];
  }
  // A claimed contract-only call has no transform to run: after validation
  // and the analyze recording above, it is handed to the host as is.
  if (contractOnly) return [contractOnlyDelegatedTag(ctx, withDefaults, node)];
  const observed = observedCall(withDefaults);
  const originalAttributeTagTree = cloneAttributeTagTree(
    withDefaults.attributeTagTree ??
      directAttributeTagTree(withDefaults.attributeTags),
  );
  const originalAttrTagProps = (withDefaults.attrTagProps ?? []).map(
    ({ name, cardinality, as, source, declared }) => ({
      name,
      cardinality,
      as,
      declared,
      source: cloneAttributeTagTree(source),
    }),
  );
  const normalizeTemplateCall = (routedCall: TagCall): TagCall => ({
    ...routedCall,
    ...rebuildAttributeTagPlan(
      call.name,
      originalAttributeTagTree,
      originalAttrTagProps,
      routedCall.attributeTags,
    ),
  });
  const builders = buildersFor(
    call.loc,
    ctx,
    node,
    call.name,
    definition,
    definition.transform ? normalizeTemplateCall : undefined,
  );
  const tagContext: TransformContext = {
    build: builders,
    hoist: (code) => ctx.hoist(code, node),
    fail: (message, at) => failForOwner(owner, message, at ?? call.loc),
    gensym: (hint) => gensymFor(ctx, call.name, hint),
    store: storeFor(ctx, call.name),
  };

  let result: IrNode[] | TagCall;
  try {
    // A sidecar may remain a macro by returning IR, or return a rewritten
    // TagCall for the adjacent template unit. A declaration-only sidecar
    // routes the validated call unchanged.
    result = definition.transform
      ? definition.transform(observed.call, tagContext)
      : routeTemplateCall(ctx, definition as TemplateBackedTag, observed.call);
  } catch (error) {
    if (isTranslateError(error)) throw error;
    throw new TranslateError(
      `${owner}: custom tag threw: ${error instanceof Error ? error.message : String(error)}`,
      call.loc.line,
      call.loc.column,
      call.loc.file,
    );
  }

  let routed = false;
  let nodes: IrNode[];
  if (Array.isArray(result)) {
    nodes = result;
  } else if (
    hasTemplate(definition) &&
    typeof result.name === "string" &&
    Array.isArray(result.attrs)
  ) {
    routed = true;
    // A transform may copy or mutate the occurrence list. In both cases the
    // authored plan must be reconciled by identity so retained tags keep
    // their control-flow shape and removed tags cannot survive in stale IR.
    const routedCall = definition.transform
      ? normalizeTemplateCall(result)
      : result;
    nodes = routeTemplateCall(ctx, definition, routedCall);
  } else {
    failForOwner(
      owner,
      "custom tag transform must return an array of IR nodes or a TagCall for its template",
      call.loc,
    );
  }
  // A routed template call reports dropped attribute tags from its metadata;
  // this proxy guard applies only to a transform that returned macro IR.
  if (
    definition.transform &&
    !routed &&
    call.attributeTags.length > 0 &&
    !observed.attributeTagsRead()
  ) {
    warn(ctx, {
      message: `${owner}: custom tag transform did not read its attributeTags; authored attribute tags were dropped`,
      line: call.loc.line,
      column: call.loc.column,
      file: call.loc.file,
    });
  }
  return nodes;
}
