/**
 * The host-independent Custom Tag contract.
 *
 * A caller discovers and loads tag definitions before compilation, then hands
 * them to the core as a name-to-definition map. The core owns validation and
 * transformation; hosts receive only ordinary IR and never learn that a
 * custom tag existed.
 */

import { attrLabel } from "./attr-label.ts";
import {
  fallbackAttrTagShape,
  unifyNestedAttrTagPlanGroups,
} from "./attr-tag.ts";
import { callNameEnd, positionAt } from "./contract-facts.ts";
import {
  type ClaimedFields,
  checkClaimedContract,
  claimedFields,
  frozenData,
} from "./contract-fields.ts";
import type { Ctx, MxWarning, Node } from "./core.ts";
import {
  codedError,
  endErrorAt,
  isTranslateError,
  TranslateError,
  warn,
} from "./core.ts";
import {
  ATTRIBUTE_TAG_DROPPED_CODE,
  CONTENT_NOT_ALLOWED_CODE,
  DIALECT_HOOK_ERROR_CODE,
  INVALID_ATTRIBUTE_TAG_CODE,
  INVALID_ATTRIBUTE_VALUE_CODE,
  INVALID_CONTRACT_CODE,
  isReservedHookCode,
  MISSING_ATTRIBUTE_CODE,
  MISSING_ATTRIBUTE_TAG_CODE,
  MISSING_CHILD_CODE,
  type MxDiagnosticCode,
  PARENT_NOT_ALLOWED_CODE,
  REPEATED_ATTRIBUTE_TAG_CODE,
  REPEATED_CHILD_CODE,
  reservedHookCodeMessage,
  STRUCTURAL_CONSTRUCT_CODE,
  TAG_ERROR_CODE,
  TAG_HOOK_ERROR_CODE,
  TAG_NOT_ALLOWED_CODE,
  TEXT_NOT_ALLOWED_CODE,
  UNCHECKABLE_CHILD_CODE,
  UNKNOWN_ATTRIBUTE_CODE,
  UNKNOWN_ATTRIBUTE_TAG_CODE,
  UNSUPPORTED_CONSTRUCT_CODE,
} from "./diagnostic-codes.ts";
import { nodeOfForward } from "./expr-nodes.ts";
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
  TagTrigger,
} from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";
import { markoViewOf } from "./marko-view.ts";
import {
  lazyOwner,
  MX_VOICE,
  type Owner,
  ownerText,
  structuralMessage,
  type Voice,
  VoiceHookError,
  voiceOfCtx,
} from "./message-vocabulary.ts";
import { isNativeVoid } from "./tag-table.ts";
import {
  hasTemplate,
  routeTemplateCall,
  type TemplateBackedTag,
} from "./template-tag.ts";
import { withoutTsWrappers } from "./ts-unwrap.ts";
import {
  attributeTagWildcardEntries,
  entryRegExp,
  explicitAttributeTagEntries,
  explicitChildEntries,
  hasExplicitChild,
  INLINE_CONTRACT_KEYS,
  matchAttributeTagWildcard,
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
   *
   * `member` (decision 182 addendum 4) accepts exactly a member a syntax
   * module produced, in either form: the static value after a kind
   * (`asc &dueOn` in Mesh) or a dynamic value that is one marked member
   * (`on:load=&visible`); nothing else. An `expression` slot accepts a
   * member too, a node-type slot refuses both forms.
   *
   * A node type key (`dialect:Type`, one the file's dialect registers in
   * `Dialect.nodeTypes`) accepts a value written as one node of that type,
   * as the whole value (`mode=:strict`, claimed by a value row or placed by
   * a trigger) or as an expression that is the node's forward. A plain
   * string, a number, an array, a function or a node of another type is
   * refused; an identifier, call, member or conditional has no knowable
   * type and passes. Which values of the type a slot allows is the
   * module's job: it claims the keys that say so (`Dialect.contractFields`)
   * and checks them itself.
   */
  type?:
    | "string"
    | "number"
    | "boolean"
    | "expression"
    | "array"
    | "function"
    | "member"
    | `${string}:${string}`;
  /**
   * The element type of an `array` attribute: a literal type, or a node
   * type key (each element written as one node of that type). A
   * non-literal element passes.
   */
  items?: "string" | "number" | "boolean" | `${string}:${string}`;
  required?: boolean;
  enum?: string[];
  default?: unknown;
  /** Reject a runtime expression when the tag needs a literal value. */
  literalOnly?: boolean;
  /**
   * Data for a syntax module that claims the key through
   * `Dialect.contractFields`. Core never reads it; without a claiming module
   * it is the unknown-key error. @unstable
   */
  values?: string[];
  /** As `values`: data a syntax module claims; core never reads it. @unstable */
  pattern?: string;
  /** As `values`: data a syntax module claims; core never reads it. @unstable */
  ref?: string | string[];
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
  /** Recursive closed attribute-tag contract, with the `"*"` wildcard. */
  attributeTags?: CustomTagAttributeTags;
  /** Closed authored children, with the reserved `#text` class and the `"*"` wildcard. */
  children?: CustomTagChildren;
}

/**
 * One `attributeTags["*"]` entry: a named attribute-tag declaration plus an
 * optional `pattern` (decision 147 for attribute tags, mirroring
 * `children["*"]`). There is no `contract` key: an entry is always an inline
 * contract. `repeatable` applies per matched name; `required` has no single
 * name to require and is rejected at registration.
 */
export interface WildcardAttributeTagEntry extends CustomTagAttributeTag {
  /**
   * JavaScript regex source matched against the whole attribute-tag name; MX
   * anchors it (`^(?:pattern)$`, no flags). Omitted, the entry matches every
   * name.
   */
  pattern?: string;
}

/** `attributeTags["*"]`: one entry, or a list tried in declaration order. */
export type WildcardAttributeTags =
  | WildcardAttributeTagEntry
  | readonly WildcardAttributeTagEntry[];

/**
 * A closed `attributeTags` record: explicit names, plus the optional `"*"`
 * entries for names no explicit entry (decision 147 for attribute tags).
 * Explicit entries win.
 */
export interface CustomTagAttributeTags {
  [name: string]: CustomTagAttributeTag | WildcardAttributeTags | undefined;
  "*"?: WildcardAttributeTags;
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
  attributeTags?: CustomTagAttributeTags;
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
      /** Why no wildcard entry may claim this name: a built-in or a registered tag, or a binding in the file. */
      known?: "built-in" | "registered" | "bound";
      /**
       * Set when a dialect's `lowerTrigger` built the child (`ctx.child`): a
       * message spells the tag as its author wrote it (`&title`) when the
       * dialect's `messageVocabulary.formatTag` says so.
       */
      trigger?: TagTrigger;
    }
  | { kind: "ChildText"; loc: Position }
  | { kind: "ChildDynamic"; loc: Position; source: string }
  | { kind: "ChildFor"; nodes: ChildNode[]; loc: Position }
  | {
      kind: "ChildIf";
      branches: Array<{ unconditional: boolean; nodes: ChildNode[] }>;
      loc: Position;
      /** An `else` or `else-if` with no `if` before it: the lowerer reports that itself. */
      orphan?: true;
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

/**
 * How a contract hook's `ctx.fail` raises its error (all optional). Passing a
 * bare `Position` instead of this object still works and means `{ at }`.
 * @unstable
 */
export interface ContractFailOptions {
  /**
   * Where the error is: a position, or a `{ sourceStart, sourceEnd }` span
   * inside the document (a call's `span` or `nameSpan`), which the
   * diagnostic keeps. The hook's own default position when absent.
   */
  readonly at?: Position | SourceSpan;
  /**
   * A machine-readable code, carried on the error as `diagnosticCode` (and on
   * a diagnostic as `code`). The code belongs to the tag's or dialect's own
   * namespace: core refuses an empty one and one starting with `MX_`, which
   * is MX's own prefix. Without it the code is `MX_TAG_ERROR`.
   */
  readonly code?: string;
}

export interface AnalyzeContext {
  store: TagStore;
  fail(message: string, options?: ContractFailOptions | Position): never;
  /**
   * Declares a name no tag states (a derived one, such as the `listId` a
   * `belongs-to` adds). Core only records it: a syntax module reads it from
   * `LoweredUnit.declared`. `span` is where an error or go-to for the name
   * points, normally the tag that caused it; `scope` names an ancestor of
   * that tag, defaulting to the file's root tag.
   */
  declare(
    kind: string,
    name: string,
    options: { span: SourceSpan; scope?: string | string[] },
  ): void;
}

export interface FinalizeContext {
  store: TagStore;
  build: IrBuilders;
  gensym(hint?: string): string;
}

/** One identifier a `/var` declares, and where it was written. */
export interface VarBinding {
  name: string;
  span?: SourceSpan;
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
  /** Set when a dialect's `lowerTrigger` built the call (`ctx.child`). */
  trigger?: TagTrigger;
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
  /**
   * UTF-16 span of the whole authored `/var` pattern (`/n`, `/{ a, b }`), so a
   * diagnostic about the binding points at it. Absent for a call without
   * `/var` or without source. Filled by `lower.ts`; optional: ignoring it is
   * safe.
   */
  varSpan?: SourceSpan;
  /**
   * Each identifier `var` declares, with its authored span. Filled by
   * `lower.ts` `varBindingsOf`; `template-tag.ts` carries it onto the routed
   * `Component`. Serves an emitter that lifts bindings into one scope and must
   * refuse a duplicate at the authored name. Optional: ignoring it is safe.
   */
  varBindings?: VarBinding[];
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
  voice: Voice = MX_VOICE,
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
          REPEATED_ATTRIBUTE_TAG_CODE,
          owner,
          `${voice.attrTag(name)} may not appear inside ${voice.tag("for")} (\`${name}\` is declared \`AttrTag\`, not \`AttrTag[]\`)`,
          occurrences[0]?.loc ?? { line: 0, column: 0 },
          nameEndOf(occurrences[0]),
          voice,
        );
      }
      if (range.max > 1) {
        failAt(
          REPEATED_ATTRIBUTE_TAG_CODE,
          owner,
          `${voice.attrTag(name)} may appear at most once (\`${name}\` is declared \`AttrTag\`, not \`AttrTag[]\`)`,
          (occurrences[1] ?? occurrences[0])?.loc ?? { line: 0, column: 0 },
          nameEndOf(occurrences[1] ?? occurrences[0]),
          voice,
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

const transformVoices = new WeakMap<TransformContext, Voice>();

/**
 * The voice of the file a transform runs for. Core-owned tags (`<try>`) spell
 * their messages through it; it is not part of the public context.
 */
export function voiceOfTransform(ctx: TransformContext): Voice {
  const voice = transformVoices.get(ctx);
  if (voice === undefined) {
    throw new Error("a transform context is built with its file's voice");
  }
  return voice;
}

export interface TransformContext {
  /** Builders that stamp synthetic nodes with the call site's position. */
  build: IrBuilders;
  /** A hygienic, per-file-unique binding name. */
  gensym(hint?: string): string;
  /** Write `throw ctx.fail(...)` so TypeScript narrows the failed branch. */
  fail(message: string, options?: ContractFailOptions | Position): never;
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
  attributeTags?: CustomTagAttributeTags;
  /**
   * Closed allowed authored children; `#text` permits non-whitespace text and
   * interpolations, and `"*"` accepts undeclared names (decision 147).
   */
  children?: CustomTagChildren;
  /** Allowed authored direct parents; `#root` is a unit's top level and `@name` an attribute tag. */
  parents?: string[];
  /**
   * Data for a syntax module that claims the key through
   * `Dialect.contractFields.tag`. Core never reads it; without a claiming
   * module it is the unknown-key error. @unstable
   */
  declares?: unknown;
  analyze?(calls: readonly TagCall[], ctx: AnalyzeContext): void;
  transform?(call: TagCall, ctx: TransformContext): IrNode[] | TagCall;
  finalize?(ctx: FinalizeContext): IrNode[];
}

/** Default export of a package-level `mx.contracts` module (decision 142). */
export type ContractMap = Record<string, CustomTag>;

/** Builders available to a transform. Module-level IR is deliberately absent. */
export interface IrBuilders {
  /**
   * Every builder below (except `expr`, which produces no positioned node,
   * and `template`, which routes the template's own positioned output) takes
   * an optional last argument `from`: where the built node's positions come
   * from. See {@link BuildFrom}. Without it the node is stamped with the call
   * site's position, as before.
   */
  text(value: string, from?: BuildFrom): IrNode;
  interpolation(expr: Expr, escaped?: boolean, from?: BuildFrom): IrNode;
  /**
   * A native element. `options.void` marks it void (no children, no close
   * tag); absent, it is void exactly when an authored element of that name
   * is: the target's `nativeTags` declares it void, else core's own HTML void
   * elements (`<br>`, `<img>`, ...). A void element given `children` is a
   * compile error at the tag; pass `{ void: false }` for an end tag.
   */
  element(
    name: string,
    attrs?: Attr[],
    children?: IrNode[],
    options?: { void?: boolean },
    from?: BuildFrom,
  ): IrNode;
  attr(name: string, value: string, from?: BuildFrom): Attr;
  dynamicAttr(name: string, value: Expr, from?: BuildFrom): Attr;
  booleanAttr(name: string, from?: BuildFrom): Attr;
  expr(code: string): Expr;
  ifChain(
    branches: Array<{ condition: Expr | null; children: IrNode[] }>,
    from?: BuildFrom,
  ): IrNode;
  forLoop(
    options: {
      source: ForSource;
      params: string[];
      bindings?: string[];
      key?: Expr | null;
      children: IrNode[];
    },
    from?: BuildFrom,
  ): IrNode;
  block(children: IrNode[], params?: string[], from?: BuildFrom): Block;
  /**
   * Requests a primitive from the active host without exposing that host.
   * `attrs` are carried on the node as given; omitted means none.
   */
  delegatedTag(
    name: string,
    children: IrNode[],
    attributeTags: AttributeTag[],
    attrs?: Attr[],
    from?: BuildFrom,
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

/** The built node's `span`: the `from` source's own span, or its name span —
 * a built node with only a name span reports that range rather than none. */
function spanOf(spans: FromSpans): { span?: SourceSpan } {
  const span = spans.span ?? spans.nameSpan;
  return span ? { span } : {};
}

/**
 * An attribute's spans from a `from` source: `nameSpan` when the source
 * carries one (today's zero span stays when it does not), and for the static
 * kind a `valueSpan` copied only when the source itself has one.
 */
function attrSpansOf(
  from: BuildFrom | undefined,
  fallback: Position,
): { nameSpan: SourceSpan; valueSpan?: SourceSpan; span?: SourceSpan } {
  const spans = spansFrom(from, fallback);
  return {
    nameSpan: spans.nameSpan ?? { sourceStart: 0, sourceEnd: 0 },
    ...(spans.valueSpan ? { valueSpan: spans.valueSpan } : {}),
    // The whole range of the attribute it was built from.
    ...(spans.attrSpan ? { span: spans.attrSpan } : {}),
  };
}

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
 * What a builder's optional trailing `from` argument accepts as the source of
 * the built node's spans:
 *
 * - an `IrNode` already in the tree (its `loc` and `span`, plus `nameSpan` for
 *   a `DelegatedTag`, read from the node itself);
 * - an `AttributeTag` (`loc`, `span`, `nameSpan`);
 * - a `TagCall` (`loc`, `span`, `nameSpan`);
 * - a plain object naming the spans directly — an attribute of the call is the
 *   common one, and an `Attr` carries `loc`, `nameSpan` and, for the static
 *   kind, `valueSpan`.
 *
 * When `from` is given, the built node takes its positions from it; when it
 * is absent, today's stamping (the call site's `loc`, zero `nameSpan`) stays.
 */
export type BuildFrom =
  | IrNode
  | AttributeTag
  | TagCall
  | {
      loc: Position;
      span?: SourceSpan;
      nameSpan?: SourceSpan;
      valueSpan?: SourceSpan;
    };

/** The spans a builder reads out of a `from` value (all but `loc` optional). */
interface FromSpans {
  loc: Position;
  span?: SourceSpan;
  /** An `Attr` source's whole span, which a built attribute copies. */
  attrSpan?: SourceSpan;
  nameSpan?: SourceSpan;
  valueSpan?: SourceSpan;
}

/**
 * Reads a `from` value's spans. Every accepted shape carries `loc`; the rest
 * are copied only when present, so a source without a span never fabricates
 * one. A `DelegatedTag` node keeps its spans on the inner tag record, which
 * this reads through.
 */
function spansFrom(from: BuildFrom | undefined, fallback: Position): FromSpans {
  if (from === undefined) return { loc: fallback };
  if ("kind" in from) {
    const inner =
      from.kind === "DelegatedTag"
        ? (from.tag as {
            span?: SourceSpan;
            nameSpan?: SourceSpan;
          })
        : (from as { span?: SourceSpan; nameSpan?: SourceSpan });
    // An `Attr`'s kinds are lowercase, an IR node's capitalized. A node built
    // from an attribute keeps the attribute's name span as its span; only a
    // built attribute takes the attribute's whole span.
    const fromAttr = /^[a-z]/.test(from.kind);
    return {
      loc: from.loc,
      ...(inner.span && !fromAttr ? { span: inner.span } : {}),
      ...(inner.span && fromAttr ? { attrSpan: inner.span } : {}),
      ...(inner.nameSpan ? { nameSpan: inner.nameSpan } : {}),
      // An `Attr` (which has a `kind`) may carry a value span for the built
      // static attribute; the other positioned shapes have none.
      ...((inner as { valueSpan?: SourceSpan }).valueSpan
        ? { valueSpan: (inner as { valueSpan?: SourceSpan }).valueSpan }
        : {}),
    };
  }
  const source = from as TagCall & { valueSpan?: SourceSpan };
  return {
    loc: source.loc,
    ...(source.span ? { span: source.span } : {}),
    ...(source.nameSpan ? { nameSpan: source.nameSpan } : {}),
    ...(source.valueSpan ? { valueSpan: source.valueSpan } : {}),
  };
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
    node: null,
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
function failAt(
  code: MxDiagnosticCode,
  tagName: string,
  message: string,
  at: Position,
  end?: number,
  voice: Voice = MX_VOICE,
): never {
  return failForOwner(
    code,
    spellAt(voice, tagName, at),
    message,
    at,
    undefined,
    end,
  );
}

/** A call's owner label, spelled through the voice (a failure is the hook error at the call). */
function tagLabelAt(
  call: Pick<TagCall, "name" | "alias" | "loc" | "trigger">,
  voice: Voice,
): string {
  try {
    return tagLabel(call.name, call.alias, voice, call.trigger);
  } catch (error) {
    if (error instanceof VoiceHookError) {
      throw codedError(
        DIALECT_HOOK_ERROR_CODE,
        error.message,
        call.loc.line,
        call.loc.column,
        call.loc.file,
      );
    }
    throw error;
  }
}

/**
 * `voice.tag(name)`, or, when the dialect's `formatTag` broke its contract,
 * the hook error at `at`: the label being built is replaced by the error about
 * the hook.
 */
function spellAt(
  voice: Voice,
  name: string,
  at: Position,
  trigger?: TagTrigger,
): string {
  try {
    return voice.tag(name, trigger);
  } catch (error) {
    if (error instanceof VoiceHookError) {
      throw codedError(
        DIALECT_HOOK_ERROR_CODE,
        error.message,
        at.line,
        at.column,
        at.file,
      );
    }
    throw error;
  }
}

function isPosition(value: unknown): value is Position {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Position).line === "number" &&
    typeof (value as Position).column === "number"
  );
}

/**
 * A contract hook's `ctx.fail`: the second argument is a `Position` (the
 * original form) or a `ContractFailOptions`; anything else is a mistake in
 * the hook, reported at `fallback` in the hook's own words.
 */
function failFromHook(
  ctx: Ctx,
  owner: Owner,
  message: string,
  arg: unknown,
  fallback: Position,
  coreOwned = false,
): never {
  const misuse = (what: string): never =>
    failForOwner(
      TAG_HOOK_ERROR_CODE,
      owner,
      `\`ctx.fail\` takes a position or \`{ at?, code? }\`: ${what}`,
      fallback,
    );
  let at = fallback;
  let span: SourceSpan | undefined;
  let code: string | undefined;
  if (arg !== undefined) {
    if (isPosition(arg)) {
      const own = ["at", "code"].filter((key) => Object.hasOwn(arg, key));
      if (own.length > 0) {
        return misuse(
          `got a position that also has \`${own[0]}\`; write \`{ at, code }\`, not \`{ ...position, ${own[0]} }\``,
        );
      }
      at = arg;
    } else if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
      return misuse(`got ${arg === null ? "null" : typeof arg}`);
    } else {
      const proto = Object.getPrototypeOf(arg);
      if (proto !== Object.prototype && proto !== null) {
        return misuse("got a non-plain object");
      }
      const options = arg as { at?: unknown; code?: unknown };
      const extra = Object.keys(options).filter(
        (key) => key !== "at" && key !== "code",
      );
      if (extra.length > 0) {
        const key = extra[0];
        return misuse(
          key === "line" || key === "column"
            ? "a position needs numeric `line` and `column`"
            : `unknown option \`${key}\``,
        );
      }
      if (options.at !== undefined) {
        if (isPosition(options.at)) {
          at = options.at;
        } else if (isSpanIn(ctx, options.at)) {
          span = {
            sourceStart: options.at.sourceStart,
            sourceEnd: options.at.sourceEnd,
          };
          at = positionAt(ctx, span.sourceStart);
        } else {
          return misuse(
            `\`at\` must be a position with \`line\` and \`column\`, or a \`{ sourceStart, sourceEnd }\` span inside the document (0 to ${ctx.source.length})`,
          );
        }
      }
      if (options.code !== undefined) {
        if (typeof options.code !== "string" || options.code === "") {
          return misuse("`code` must be a non-empty string");
        }
        if (!coreOwned && isReservedHookCode(options.code)) {
          return misuse(reservedHookCodeMessage(options.code, "the tag's"));
        }
        code = options.code;
      }
    }
  }
  try {
    return failForOwner(
      TAG_ERROR_CODE,
      owner,
      message,
      at,
      undefined,
      span?.sourceEnd,
    );
  } catch (error) {
    if (isTranslateError(error)) {
      if (code !== undefined) error.diagnosticCode = code;
      if (span !== undefined) error.span = span;
    }
    throw error;
  }
}

/** Whether `value` is a `{ sourceStart, sourceEnd }` span inside `ctx.source`. */
function isSpanIn(ctx: Ctx, value: unknown): value is SourceSpan {
  const at = value as SourceSpan | null | undefined;
  return (
    typeof at === "object" &&
    at !== null &&
    Number.isInteger(at.sourceStart) &&
    Number.isInteger(at.sourceEnd) &&
    at.sourceStart >= 0 &&
    at.sourceStart <= at.sourceEnd &&
    at.sourceEnd <= ctx.source.length
  );
}

/**
 * Core's own tag definitions (`<try>`): their `ctx.fail` may pass one of
 * MX's own `MX_` codes, which a dialect's or an author's hook may not.
 */
const coreOwnedTags = new WeakSet<CustomTag>();

/** Marks `definition` as core's own, for {@link coreOwnedTags}. */
export function markCoreOwned(definition: CustomTag): CustomTag {
  coreOwnedTags.add(definition);
  return definition;
}

/** An already formatted owner chain, shared by contracts at every depth. */
function failForOwner(
  code: MxDiagnosticCode,
  owner: Owner,
  message: string,
  at: Position,
  occurrence?: TagOccurrence,
  end?: number,
): never {
  const error = codedError(
    code,
    `${ownerText(owner)}: ${message}`,
    at.line,
    at.column,
    at.file,
  );
  if (occurrence !== undefined) occurrences.set(error, occurrence);
  // Where the blamed construct ends in the file (exclusive): a tag at the end
  // of its `<name`, an attribute after its value.
  endErrorAt(error, end);
  throw error;
}

/** Where a blamed tag ends: its `<name`. */
function nameEndOf(tag: { nameSpan?: SourceSpan | null } | undefined) {
  return tag?.nameSpan?.sourceEnd;
}

/** Where a blamed attribute ends: after its value. */
function attrEndOf(attr: { span?: SourceSpan } | undefined) {
  return attr?.span?.sourceEnd;
}

/** The authored tag a "not allowed here" error is about. */
export interface TagOccurrence {
  readonly name: string;
  /** The file offset of the tag's `<`, as the authored-tag scan reports it. */
  readonly offset: number;
  /**
   * What the not-allowed message told the author beyond "not allowed": the
   * wildcard rule and any hint. Absent for a plain closed parent.
   */
  readonly guidance?: string;
}

/**
 * The file offset of each authored child tag in a `ChildNode` tree. Internal,
 * so the exported `ChildNode` a hook reads through `TagCall.childTree` is
 * unchanged.
 */
const childOffsets = new WeakMap<object, number>();

/** Records where `node`'s `<` is in the file (an MX node). */
export function setChildOffset(node: object, offset: number): void {
  childOffsets.set(node, offset);
}

/** Where each authored child ends in the file: a tag's `<name`, a text run's text. */
const childEnds = new WeakMap<object, number>();

/** Records where `node` (an authored child) ends in the file. */
export function setChildEnd(node: object, offset: number): void {
  childEnds.set(node, offset);
}

/**
 * Which tag occurrence each `MX_TAG_NOT_ALLOWED` error is about. Internal:
 * `lowerSource` reads it to give a tag that is also unknown one error, not two.
 */
const occurrences = new WeakMap<TranslateError, TagOccurrence>();

/** The tag occurrence `error` (a not-allowed error) is about, when recorded. */
export function tagOccurrenceOf(error: unknown): TagOccurrence | undefined {
  return error instanceof TranslateError ? occurrences.get(error) : undefined;
}

/**
 * `error` as one error and nothing more. The first error a walk raised carries
 * every error it recorded (`errors`, see `collectedError`), so a list that
 * kept it and dropped one of the others would give that one back the next time
 * the list is flattened. This copy has no such list, and keeps the position,
 * code, file, spans and the occurrence recorded for it. An error with no list
 * is returned as it is. The original is not touched: other readers still see
 * its list.
 */
export function withoutCollected(error: unknown): unknown {
  if (!(error instanceof TranslateError) || error.errors === undefined) {
    return error;
  }
  const copy = Object.create(Object.getPrototypeOf(error)) as TranslateError;
  Object.defineProperties(copy, Object.getOwnPropertyDescriptors(error));
  delete (copy as { errors?: unknown }).errors;
  const occurrence = occurrences.get(error);
  if (occurrence !== undefined) occurrences.set(copy, occurrence);
  return copy;
}

export function buildersFor(
  loc: Position,
  ctx: Ctx,
  node: Node | null,
  tagName: string,
  definition: CustomTag,
  normalizeTemplateCall?: (call: TagCall) => TagCall,
): IrBuilders {
  return {
    text: (value, from) => {
      const spans = spansFrom(from, loc);
      return { kind: "Text", value, loc: spans.loc, ...spanOf(spans) };
    },
    interpolation: (value, escaped = true, from) => {
      const spans = spansFrom(from, loc);
      return {
        kind: "Interpolation",
        expr: value,
        escaped,
        loc: spans.loc,
        ...spanOf(spans),
      };
    },
    element: (name, attrs = [], children = [], options = {}, from) => {
      const spans = spansFrom(from, loc);
      // Absent, void follows the target's table, as an authored element's
      // does (`<br>` is void, `<box>` is when the target declares it).
      const isVoid =
        options.void ?? isNativeVoid(ctx.declarations.nativeTags, name);
      // Every emitter drops a void element's children (IR spec E8), so
      // building one with children is an error, never a silent drop.
      if (isVoid && children.length > 0) {
        return failAt(
          TAG_HOOK_ERROR_CODE,
          tagName,
          `${voiceOfCtx(ctx).tag(name)} is void and takes no children; pass { void: false } to emit an end tag`,
          loc,
          undefined,
          voiceOfCtx(ctx),
        );
      }
      return {
        kind: "Element",
        name,
        attrs,
        children,
        void: isVoid,
        loc: spans.loc,
        ...spanOf(spans),
      };
    },
    attr: (name, value, from) => ({
      kind: "static",
      name,
      value,
      ...attrSpansOf(from, loc),
      loc: spansFrom(from, loc).loc,
    }),
    dynamicAttr: (name, value, from) => ({
      kind: "dynamic",
      name,
      value,
      ...attrSpansOf(from, loc),
      loc: spansFrom(from, loc).loc,
    }),
    booleanAttr: (name, from) => ({
      kind: "boolean",
      name,
      ...attrSpansOf(from, loc),
      loc: spansFrom(from, loc).loc,
    }),
    expr: syntheticExpr,
    ifChain: (branches, from) => {
      const spans = spansFrom(from, loc);
      return {
        kind: "IfChain",
        branches: branches.map(
          (branch): Branch => ({
            ...branch,
            loc: spans.loc,
            ...spanOf(spans),
          }),
        ),
        loc: spans.loc,
        ...spanOf(spans),
      };
    },
    forLoop: (options, from) => {
      const spans = spansFrom(from, loc);
      return {
        kind: "For",
        source: options.source,
        params: options.params,
        paramNodes: [],
        bindings: options.bindings ?? options.params,
        key: options.key ?? null,
        children: options.children,
        loc: spans.loc,
        ...spanOf(spans),
      };
    },
    block: (children, params = [], from) => ({
      hasParams: params.length > 0,
      params,
      children,
      loc: spansFrom(from, loc).loc,
    }),
    delegatedTag: (name, children, attributeTags, attrs = [], from) => {
      const spans = spansFrom(from, loc);
      if (node === null) {
        return failAt(
          TAG_HOOK_ERROR_CODE,
          tagName,
          "`ctx.build.delegatedTag` is not available in `finalize`",
          loc,
          undefined,
          voiceOfCtx(ctx),
        );
      }
      if (ctx.declarations.isDelegatedTag?.(name, ctx) !== true) {
        return failAt(
          TAG_HOOK_ERROR_CODE,
          tagName,
          `this host does not claim ${voiceOfCtx(ctx).tag(name)}, so a custom tag cannot emit one`,
          loc,
          undefined,
          voiceOfCtx(ctx),
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
          ...(spans.nameSpan ? { nameSpan: spans.nameSpan } : {}),
          ...(spans.span || spans.nameSpan
            ? { span: spans.span ?? spans.nameSpan }
            : {}),
          attrs,
          children,
          attributeTags,
          attributeTagTree,
          attrTagProps,
          params: [],
          var: null,
          data: ctx.declarations.resolveDelegatedTag?.(
            name,
            markoViewOf(ctx, node),
            ctx,
          ),
          loc: spans.loc,
        },
        loc: spans.loc,
      };
    },
    template: (call) => {
      if (node === null) {
        return failAt(
          TAG_HOOK_ERROR_CODE,
          tagName,
          "`ctx.build.template` is not available in `finalize`",
          loc,
          undefined,
          voiceOfCtx(ctx),
        );
      }
      if (!hasTemplate(definition)) {
        return failAt(
          TAG_HOOK_ERROR_CODE,
          tagName,
          "this tag has no template file, so `ctx.build.template(call)` has nothing to expand",
          loc,
          undefined,
          voiceOfCtx(ctx),
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

/** A node type's key in contracts: `dialect:Type` (`Dialect.nodeTypes`). */
type NodeTypeKey = `${string}:${string}`;

interface LiteralValue {
  type: "string" | "number" | "boolean" | "member" | NodeTypeKey;
  value: string | number | boolean;
}

/** Is `type` a node type key (`dialect:Type`), not one of core's value types? */
function isNodeTypeKey(type: unknown): type is NodeTypeKey {
  return typeof type === "string" && /^[^:\s]+:[^:\s]+$/.test(type);
}

/**
 * The type of a dialect's node (`dialect:Type`), or `undefined` for none and
 * for core's own types (`mx:String`, `mx:Expression`): a value written as
 * one of those is a string or an expression, as if no row had claimed it.
 */
function dialectTypeOf(
  node: { readonly type: string } | undefined,
): NodeTypeKey | undefined {
  return node && !node.type.startsWith("mx:") && isNodeTypeKey(node.type)
    ? node.type
    : undefined;
}

/**
 * The node type a static attribute's whole value was written as. A sugar's
 * node (a trigger's token that made the attribute, `Attr.sugar`) reads as
 * its string for every contract but its own type's.
 */
function staticNodeType(
  attr: Extract<Attr, { kind: "static" }>,
): NodeTypeKey | undefined {
  return attr.sugar ? undefined : dialectTypeOf(attr.node);
}

function listEnum(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function literalValue(attr: Attr): LiteralValue | null {
  if (attr.kind === "static") {
    // A node written as the whole value keeps its type; a sugar's node
    // (`Attr.sugar`) reads as its string for every contract but its own
    // type's.
    return {
      type: attr.member ? "member" : (staticNodeType(attr) ?? "string"),
      value: attr.value,
    };
  }
  if (attr.kind === "boolean") return { type: "boolean", value: true };
  if (attr.kind !== "dynamic") return null;

  // Under `stripTypes: false` an assertion stays around the literal.
  const node = withoutTsWrappers(attr.value.node);
  switch (node?.type) {
    case "StringLiteral":
      return {
        type: dialectTypeOf(nodeOfForward(node)) ?? "string",
        value: node.value,
      };
    case "NumericLiteral":
      return { type: "number", value: node.value };
    case "BooleanLiteral":
      return { type: "boolean", value: node.value };
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
function isLiteralNode(written: Node | null | undefined): boolean {
  const node = withoutTsWrappers(written);
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
function nodeShape(written: Node | null | undefined): string | null {
  const node = withoutTsWrappers(written);
  // A dialect's node, lowered to this expression (its forward), has the
  // node's type whatever the forward is.
  const claimed = node ? dialectTypeOf(nodeOfForward(node)) : undefined;
  if (claimed) return claimed;
  switch (node?.type) {
    case "StringLiteral":
      return "string";
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
      return node.operator === "-" &&
        withoutTsWrappers(node.argument).type === "NumericLiteral"
        ? "number"
        : null;
    default:
      return null;
  }
}

/** The written type of an attribute's value, or `null` when it cannot be known. */
function attrShape(attr: Attr): string | null {
  if (attr.kind === "static") {
    if (attr.member) return "member";
    return staticNodeType(attr) ?? "string";
  }
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
  owner: Owner,
  attr: Exclude<Attr, { kind: "spread" }>,
  declaration: CustomTagAttribute,
  voice: Voice = MX_VOICE,
): void {
  const shape = attrShape(attr);
  if (shape && shape !== declaration.type) {
    failForOwner(
      INVALID_ATTRIBUTE_VALUE_CODE,
      owner,
      `${voice.attribute} ${attrLabel(attr)} must be ${declaration.type}, got ${shape}`,
      attr.loc,
      undefined,
      attrEndOf(attr),
    );
  }
  if (
    declaration.type !== "array" ||
    !declaration.items ||
    (attr.kind !== "dynamic" && attr.kind !== "bound") ||
    withoutTsWrappers(attr.value.node)?.type !== "ArrayExpression"
  ) {
    return;
  }
  const elements = withoutTsWrappers(attr.value.node)
    .elements as Array<Node | null>;
  for (const [index, element] of elements.entries()) {
    const got = nodeShape(element);
    if (!element || !got || got === declaration.items) continue;
    const start = element.loc?.start;
    failForOwner(
      INVALID_ATTRIBUTE_VALUE_CODE,
      owner,
      `${voice.attribute} ${attrLabel(attr)} item ${index + 1} must be ${declaration.items}, got ${got}`,
      start
        ? { ...attr.loc, line: start.line, column: start.column }
        : attr.loc,
      undefined,
      attrEndOf(attr),
    );
  }
}

/**
 * Checks a node-type attribute (`type: "dialect:Type"`) against its written
 * shape: one node of that type, as the whole value or as an expression that
 * is the node's forward. A string, a number, an array, a function, a member
 * or a node of another type is a type error at the offending value; an
 * identifier, call, member or conditional has no knowable type and passes.
 * Which values of the type are allowed is the claiming module's business.
 */
function checkNodeAttr(
  owner: Owner,
  attr: Exclude<Attr, { kind: "spread" }>,
  declaration: CustomTagAttribute & { type: NodeTypeKey },
  locate?: Locate,
  claims?: ClaimContext,
): void {
  const type = declaration.type;
  const expected = expectationOf(declaration, claims?.claimed);
  const voice = claims?.voice ?? MX_VOICE;
  const at = valueLoc(attr, locate);
  // A node of the type, a sugar's included, satisfies the slot.
  if (attr.kind === "static" && dialectTypeOf(attr.node) === type) return;
  // A member is not a node, in either form (spec §13.9.6).
  if (isMemberValue(attr)) {
    failForOwner(
      INVALID_ATTRIBUTE_VALUE_CODE,
      owner,
      `${voice.attribute} ${attrLabel(attr)} must be ${type}, got a member${expected}`,
      at,
      undefined,
      attrEndOf(attr),
    );
  }
  // A plain string against a declaration that uses a key the module
  // claims: the module may word it itself (it can list the values), so
  // the shape check stays core's but its error is queued behind the module's
  // `afterLower`. The module's diagnostics keep their order, and a module that
  // checks nothing still gets the error.
  if (
    claims &&
    usesClaimedKey(declaration, claims.claimed) &&
    plainStringOf(attr) !== undefined
  ) {
    claims.defer(
      codedError(
        INVALID_ATTRIBUTE_VALUE_CODE,
        `${ownerText(owner)}: ${voice.attribute} ${attrLabel(attr)} must be ${type}, got string${expected}`,
        at.line,
        at.column,
        at.file,
      ),
    );
    return;
  }
  const shape = attrShape(attr);
  if (shape && shape !== type) {
    failForOwner(
      INVALID_ATTRIBUTE_VALUE_CODE,
      owner,
      `${voice.attribute} ${attrLabel(attr)} must be ${type}, got ${shape}${expected}`,
      at,
      undefined,
      attrEndOf(attr),
    );
  }
}

/**
 * A member value, in both forms the `"member"` type accepts (decision 182
 * addendum 4, lead ruling on Mesh's M5): the static value after a kind
 * (`asc &dueOn`), and a dynamic attribute whose value is exactly one marked
 * member (`on:load=&visible`).
 */
function isMemberValue(attr: Attr): boolean {
  if (attr.kind === "static") return attr.member !== undefined;
  return (
    attr.kind === "dynamic" &&
    !!withoutTsWrappers(attr.value.node)?.extra?.mxMember
  );
}

/**
 * A `type: "member"` slot (decision 182 addendum 4) takes exactly a
 * member a dialect produced, in either form (`isMemberValue`); an
 * atom, a string, a bare attribute or any other expression is refused,
 * naming what was written.
 */
function checkMemberAttr(
  owner: Owner,
  attr: Exclude<Attr, { kind: "spread" }>,
  locate?: Locate,
  voice: Voice = MX_VOICE,
): void {
  if (isMemberValue(attr)) return;
  const got =
    attr.kind === "static"
      ? (staticNodeType(attr) ?? "a string")
      : attr.kind === "boolean"
        ? `a bare ${voice.attribute}`
        : "an expression";
  failForOwner(
    INVALID_ATTRIBUTE_VALUE_CODE,
    owner,
    `${voice.attribute} ${attrLabel(attr)} must be a member, got ${got}`,
    valueLoc(attr, locate),
    undefined,
    attrEndOf(attr),
  );
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
    INVALID_CONTRACT_CODE,
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
  givenLabel?: Owner,
  nameEnd?: number,
  voice: Voice = MX_VOICE,
  trigger?: TagTrigger,
): void {
  const parents = definition.parents;
  // A dynamic parent's diagnostic placeholder is not an authored name.
  if (!parents || (parent !== `\${…}` && parents.includes(parent))) return;
  const label = givenLabel
    ? ownerText(givenLabel)
    : spellAt(voice, name, loc, trigger);
  const named = parents.filter((allowed) => allowed !== "#root");
  const inside = named.map((allowed) => voice.tag(allowed)).join(", ");
  const required = inside
    ? `inside ${inside}${parents.includes("#root") ? " or at the top level" : ""}`
    : parents.includes("#root")
      ? "at the top level"
      : "inside an allowed parent (none declared)";
  const found =
    parent === "#root" ? "at the top level" : `inside ${voice.tag(parent)}`;
  const error = codedError(
    PARENT_NOT_ALLOWED_CODE,
    `${label} must be ${required}; found ${found}`,
    loc.line,
    loc.column,
    loc.file,
  );
  endErrorAt(error, nameEnd);
  throw error;
}

/**
 * Under `structural: "reject"`, a `for` or `if` written directly in the body
 * of a tag with a `transform` is the error, reported here at the construct
 * with the message the IR check gives. That check only sees constructs that
 * reach the IR, and a transform may consume its body, so it cannot be left to
 * report this one. The lowering fails here, so the IR check does not run and
 * cannot report it a second time.
 */
export function rejectStructuralBody(
  call: Pick<TagCall, "childTree">,
  voice: Voice,
): void {
  for (const node of call.childTree ?? []) {
    if (node.kind !== "ChildFor" && node.kind !== "ChildIf") continue;
    if (node.kind === "ChildIf" && node.orphan) continue;
    throw structuralConstructError(
      node.kind === "ChildFor" ? "for" : "if",
      node.loc,
      voice,
      childEnds.get(node),
    );
  }
}

/** The structural-reject error for a `for` or `if` at `loc`, ending at `end`. */
export function structuralConstructError(
  keyword: "for" | "if",
  loc: Position,
  voice: Voice,
  end: number | undefined,
): TranslateError {
  let error: TranslateError;
  try {
    error = codedError(
      STRUCTURAL_CONSTRUCT_CODE,
      structuralMessage(voice.tag(keyword), voice),
      loc.line,
      loc.column,
      loc.file,
    );
  } catch (hookFailure) {
    if (!(hookFailure instanceof VoiceHookError)) throw hookFailure;
    error = codedError(
      DIALECT_HOOK_ERROR_CODE,
      hookFailure.message,
      loc.line,
      loc.column,
      loc.file,
    );
  }
  endErrorAt(error, end);
  return error;
}

/** Validates authored children before any plain child is lowered. */
export function validateCustomTagChildren(
  definition: Pick<CustomTag, "children">,
  call: Pick<TagCall, "name" | "loc" | "childTree"> & { trigger?: TagTrigger },
  givenOwner?: Owner,
  nameEnd?: number,
  voice: Voice = MX_VOICE,
  rejectsStructural = false,
): void {
  if (!definition.children) return;
  const owner: Owner =
    givenOwner ??
    lazyOwner(() => spellAt(voice, call.name, call.loc, call.trigger));
  const declarations = definition.children;
  const explicit = explicitChildEntries(declarations);
  const entries = wildcardEntries(declarations);
  const tree = call.childTree ?? [];
  const leaves: Array<Extract<ChildNode, { kind: "ChildTag" | "ChildText" }>> =
    [];
  // Spelled when a message needs it: a valid file spells nothing.
  const allowedNames = (): string =>
    explicit.map(([name]) => voice.tag(name)).join(", ") || "none";
  // Check order (decision 147): an explicit entry, then the `"*"` entries in
  // order (the lowerer already matched them, recorded on the child), then the
  // closed record's own error.
  const notAllowed = (
    node: Extract<ChildNode, { kind: "ChildTag" }>,
  ): { message: string; guidance?: string } => {
    const label = voice.tag(node.name, node.trigger);
    const hint = node.hint ? ` ${node.hint}` : "";
    if (entries.length === 0) {
      return {
        message: `${label} is not allowed here; allowed children: ${allowedNames()}${hint}`,
        ...(hint ? { guidance: hint.trim() } : {}),
      };
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
      ? `${others} must match ${patterns}${catchAll ? ", or not already be a tag" : ""}`
      : `${others} must not already be a tag`;
    const known = node.known
      ? matchWildcardEntry(declarations, node.name)
        ? node.known === "bound"
          ? ` (${label} is bound in this file, so the wildcard does not apply to it; rename the binding)`
          : ` (${label} is ${node.known === "built-in" ? "a built-in tag" : "a registered tag"}, so the wildcard does not apply to it)`
        : ""
      : "";
    const listed =
      names.length > 0
        ? `allowed children: ${names.map(([name]) => voice.tag(name)).join(", ")}; `
        : "";
    return {
      message: `${label} is not allowed here; ${listed}${rule}${known}${hint}`,
      guidance: `${listed}${rule}${known}${hint}`,
    };
  };
  // What a text child is told the parent does accept; a wildcard entry means
  // tags are accepted even when no child is named.
  const textRule = (): string =>
    entries.length > 0
      ? `it accepts only child tags: ${[
          ...explicit.flatMap(([name]) =>
            name === "#text" ? [] : [voice.tag(name)],
          ),
          ...entries.map((entry) =>
            entry.pattern === undefined
              ? "any other name"
              : `names matching \`${entry.pattern}\``,
          ),
        ].join(", ")}`
      : allowedNames() === "none"
        ? "it accepts no child tags"
        : `it accepts only the child tags ${allowedNames()}`;
  // Under `structural: "reject"` a `for` or `if` is the error: what it holds
  // is not checked against the contract, so that error is the one reported.
  const collect = (nodes: readonly ChildNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "ChildFor" || node.kind === "ChildIf") {
        if (rejectsStructural) continue;
      }
      if (node.kind === "ChildFor") collect(node.nodes);
      else if (node.kind === "ChildIf") {
        for (const branch of node.branches) collect(branch.nodes);
      } else if (node.kind === "ChildDynamic") {
        failForOwner(
          UNCHECKABLE_CHILD_CODE,
          owner,
          `a dynamic tag ${voice.dynamicTag(node.source, undefined, "…")} cannot be checked against the declared children`,
          node.loc,
          undefined,
          childEnds.get(node),
        );
      } else {
        const name = node.kind === "ChildTag" ? node.name : "#text";
        const matched = node.kind === "ChildTag" && node.alias !== undefined;
        if (!matched && !hasExplicitChild(declarations, name)) {
          if (node.kind === "ChildText") {
            failForOwner(
              TEXT_NOT_ALLOWED_CODE,
              owner,
              `text is not allowed here; ${textRule()}`,
              node.loc,
              undefined,
              childEnds.get(node),
            );
          }
          const offset = childOffsets.get(node);
          let spelled: { message: string; guidance?: string };
          try {
            spelled = notAllowed(node);
          } catch (error) {
            if (!(error instanceof VoiceHookError)) throw error;
            // The hook broke while spelling this child: the error is about
            // this child, at it, and marked as its occurrence so that, when
            // the same tag is also reported as unknown, that report (which
            // spells it too) is the one the user gets.
            const hookError = codedError(
              DIALECT_HOOK_ERROR_CODE,
              error.message,
              node.loc.line,
              node.loc.column,
              node.loc.file,
            );
            if (offset !== undefined) {
              occurrences.set(hookError, { name: node.name, offset });
            }
            endErrorAt(hookError, childEnds.get(node));
            throw hookError;
          }
          const { message, guidance } = spelled;
          failForOwner(
            TAG_NOT_ALLOWED_CODE,
            owner,
            message,
            node.loc,
            offset === undefined
              ? undefined
              : {
                  name: node.name,
                  offset,
                  ...(guidance
                    ? { guidance: `inside ${ownerText(owner)}: ${guidance}` }
                    : {}),
                },
            childEnds.get(node),
          );
        }
        leaves.push(node);
      }
    }
  };
  collect(tree);
  // One identity per tag (ADR 147): a wildcard child counts under its
  // canonical name against that name's explicit entry.
  // A rejected construct holds no child that counts as repeated or as the one
  // a required child needs.
  const counted = rejectsStructural
    ? tree.filter((node) => node.kind !== "ChildFor" && node.kind !== "ChildIf")
    : tree;
  for (const [name, declaration] of explicit) {
    const range = attributeTagOccurrenceRange(counted, name);
    const inRejected =
      rejectsStructural &&
      attributeTagOccurrenceRange(tree, name).max > range.max;
    if (declaration.repeatable !== true && range.max > 1) {
      const occurrences = leaves.filter(
        (node) => (node.kind === "ChildTag" ? node.name : "#text") === name,
      );
      const repeated = occurrences[1] ?? occurrences[0];
      const label =
        repeated?.kind === "ChildTag"
          ? tagLabel(repeated.name, repeated.alias, voice, repeated.trigger)
          : voice.tag(name);
      failForOwner(
        REPEATED_CHILD_CODE,
        owner,
        `${label} may not be repeated`,
        repeated?.loc ?? call.loc,
        undefined,
        repeated ? childEnds.get(repeated) : nameEnd,
      );
    }
    if (declaration.required && range.min === 0 && !inRejected) {
      failForOwner(
        MISSING_CHILD_CODE,
        owner,
        `missing required child ${voice.tag(name)}`,
        call.loc,
        undefined,
        nameEnd,
      );
    }
  }
}

/** Offset to line and column in the file being compiled. */
type Locate = (offset: number) => { line: number; column: number };

/** Where an attribute's value starts: the string, the node or the expression; the attribute when it has none. */
function valueLoc(attr: Attr, locate?: Locate): Position {
  if (!locate || attr.kind === "spread") return attr.loc;
  let offset: number | undefined;
  if (attr.kind === "static") {
    offset = (dialectTypeOf(attr.node) ? attr.node?.span : attr.valueSpan)
      ?.sourceStart;
  } else if (attr.kind === "dynamic" || attr.kind === "bound") {
    offset = attr.value.span?.sourceStart;
  }
  return offset === undefined ? attr.loc : { ...attr.loc, ...locate(offset) };
}

/** Where a value error points: at a whole-value node when the offset can be located, else the attribute. */
function valueAt(attr: Attr, locate?: Locate): Position {
  if (
    attr.kind === "static" &&
    dialectTypeOf(attr.node) &&
    attr.node &&
    locate
  ) {
    return { ...attr.loc, ...locate(attr.node.span.sourceStart) };
  }
  return attr.loc;
}

/** One attribute checker for top-level tags and every declared attribute tag. */
function validateAttributes(
  owner: Owner,
  attributes: CustomTag["attributes"],
  attrs: readonly Attr[],
  loc: Position,
  locate?: Locate,
  claims?: ClaimContext,
  locEnd?: number,
): void {
  if (!attributes) return;
  const voice = claims?.voice ?? MX_VOICE;
  // An empty closed contract rejects named and spread attributes identically.
  const acceptsNone = Object.keys(attributes).length === 0;
  const present = new Set<string>();
  for (const attr of attrs) {
    if (attr.kind === "spread") {
      failForOwner(
        UNKNOWN_ATTRIBUTE_CODE,
        owner,
        acceptsNone
          ? `accepts no ${voice.attributes}`
          : `spread ${voice.attributes} cannot be checked against this tag's declared ${voice.attributes}`,
        attr.loc,
        undefined,
        attrEndOf(attr),
      );
    }
    const declaration = Object.hasOwn(attributes, attr.name)
      ? attributes[attr.name]
      : undefined;
    if (!declaration) {
      failForOwner(
        UNKNOWN_ATTRIBUTE_CODE,
        owner,
        acceptsNone
          ? `accepts no ${voice.attributes}`
          : `unknown ${voice.attribute} ${attrLabel(attr)}`,
        attr.loc,
        undefined,
        attrEndOf(attr),
      );
    }
    present.add(attr.name);
    const literal = literalValue(attr);
    if (declaration.literalOnly && !isLiteralAttr(attr)) {
      failForOwner(
        INVALID_ATTRIBUTE_VALUE_CODE,
        owner,
        `${voice.attribute} ${attrLabel(attr)} must be a literal`,
        attr.loc,
        undefined,
        attrEndOf(attr),
      );
    }
    if (isNodeTypeKey(declaration.type)) {
      checkNodeAttr(
        owner,
        attr,
        declaration as CustomTagAttribute & { type: NodeTypeKey },
        locate,
        claims,
      );
    } else if (declaration.type === "member") {
      checkMemberAttr(owner, attr, locate, voice);
    } else if (
      declaration.type === "array" ||
      declaration.type === "function"
    ) {
      checkCompositeAttr(owner, attr, declaration, voice);
    } else if (
      declaration.type &&
      declaration.type !== "expression" &&
      literal &&
      declaration.type !== literal.type
    ) {
      failForOwner(
        INVALID_ATTRIBUTE_VALUE_CODE,
        owner,
        `${voice.attribute} ${attrLabel(attr)} must be ${declaration.type}, got ${literal.type}`,
        valueAt(attr, locate),
        undefined,
        attrEndOf(attr),
      );
    }
    if (
      declaration.type === "expression" &&
      ((attr.kind === "static" && !dialectTypeOf(attr.node) && !attr.member) ||
        attr.kind === "boolean")
    ) {
      failForOwner(
        INVALID_ATTRIBUTE_VALUE_CODE,
        owner,
        `${voice.attribute} ${attrLabel(attr)} must be an expression`,
        attr.loc,
        undefined,
        attrEndOf(attr),
      );
    }
    if (declaration.enum) {
      if (!literal) {
        failForOwner(
          INVALID_ATTRIBUTE_VALUE_CODE,
          owner,
          `${voice.attribute} ${attrLabel(attr)} must be a static value from ${listEnum(declaration.enum)}`,
          attr.loc,
          undefined,
          attrEndOf(attr),
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
          INVALID_ATTRIBUTE_VALUE_CODE,
          owner,
          `${voice.attribute} ${attrLabel(attr)} must be a string from ${listEnum(declaration.enum)}, got ${literal.type}`,
          attr.loc,
          undefined,
          attrEndOf(attr),
        );
      }
      if (!declaration.enum.includes(literal.value)) {
        failForOwner(
          INVALID_ATTRIBUTE_VALUE_CODE,
          owner,
          `${voice.attribute} ${attrLabel(attr)} must be one of ${listEnum(declaration.enum)}, got ${JSON.stringify(literal.value)}`,
          attr.loc,
          undefined,
          attrEndOf(attr),
        );
      }
    }
  }
  for (const [name, declaration] of Object.entries(attributes)) {
    if (declaration.required && !present.has(name)) {
      failForOwner(
        MISSING_ATTRIBUTE_CODE,
        owner,
        `missing required ${voice.attribute} \`${name}\``,
        loc,
        undefined,
        locEnd,
      );
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
  owner: Owner,
  declaredTags: CustomTag["attributeTags"],
  tags: readonly AttributeTag[],
  tree: readonly AttributeTagNode[],
  loc: Position,
  allowUncontractedTags: boolean,
  locate?: Locate,
  claims?: ClaimContext,
  locEnd?: number,
): void {
  const voice = claims?.voice ?? MX_VOICE;
  const wildcardMatches = new Map<
    string,
    { entry: CustomTagAttributeTag; loc: Position }
  >();
  for (const tag of tags) {
    const explicitDeclared =
      declaredTags && Object.hasOwn(declaredTags, tag.name)
        ? (declaredTags[tag.name] as CustomTagAttributeTag | undefined)
        : undefined;
    // Check order (decision 147, for attribute tags): an explicit entry, then
    // the `"*"` entries in order; no match leaves today's unknown-name error.
    const declaration =
      explicitDeclared ?? matchAttributeTagWildcard(declaredTags, tag.name);
    if (declaration && !explicitDeclared) {
      wildcardMatches.set(tag.name, { entry: declaration, loc: tag.loc });
    }
    const extended = hasAttributeTagContract(declaration);
    if (!allowUncontractedTags && !extended) {
      if (tag.attrs.length > 0) {
        failForOwner(
          INVALID_ATTRIBUTE_TAG_CODE,
          owner,
          `${voice.attributeTag} ${voice.attrTag(tag.name)} does not support ${voice.attributes}`,
          tag.attrs[0]?.loc ?? tag.loc,
          undefined,
          tag.attrs[0] ? attrEndOf(tag.attrs[0]) : nameEndOf(tag),
        );
      }
      if (tag.attributeTags.length > 0) {
        failForOwner(
          INVALID_ATTRIBUTE_TAG_CODE,
          owner,
          `${voice.attributeTag} ${voice.attrTag(tag.name)} does not support nested ${voice.attributeTags}`,
          tag.attributeTags[0]?.loc ?? tag.loc,
          undefined,
          nameEndOf(tag.attributeTags[0] ?? tag),
        );
      }
    }
    if (declaredTags && !declaration) {
      failForOwner(
        UNKNOWN_ATTRIBUTE_TAG_CODE,
        owner,
        `unknown ${voice.attributeTag} ${voice.attrTag(tag.name)}`,
        tag.loc,
        undefined,
        nameEndOf(tag),
      );
    }
    if (declaration) {
      const nestedOwner: Owner = lazyOwner(
        () => `${ownerText(owner)}: ${voice.attrTag(tag.name)}`,
      );
      validateAttributes(
        nestedOwner,
        declaration.attributes,
        tag.attrs,
        tag.loc,
        locate,
        claims,
        nameEndOf(tag),
      );
      validateAttributeTags(
        nestedOwner,
        declaration.attributeTags,
        tag.attributeTags,
        tag.attributeTagTree,
        tag.loc,
        allowUncontractedTags ||
          (extended && declaration.attributeTags === undefined),
        locate,
        claims,
        nameEndOf(tag),
      );
    }
  }
  for (const [name, declaration] of explicitAttributeTagEntries(declaredTags)) {
    const range = attributeTagOccurrenceRange(tree, name);
    if (declaration.repeatable !== true && range.max > 1) {
      const occurrences = tags.filter((tag) => tag.name === name);
      failForOwner(
        REPEATED_ATTRIBUTE_TAG_CODE,
        owner,
        `${voice.attributeTag} ${voice.attrTag(name)} may not be repeated`,
        occurrences[1]?.loc ?? occurrences[0]?.loc ?? loc,
        undefined,
        occurrences.length > 0
          ? nameEndOf(occurrences[1] ?? occurrences[0])
          : locEnd,
      );
    }
    if (declaration.required && range.min === 0) {
      failForOwner(
        MISSING_ATTRIBUTE_TAG_CODE,
        owner,
        `missing required ${voice.attributeTag} ${voice.attrTag(name)}`,
        loc,
        undefined,
        locEnd,
      );
    }
  }
  // A `"*"` entry's cardinality is per matched name: two `<@row>` under one
  // non-repeatable entry is one error naming `row` (decision 147, for
  // attribute tags). `required` cannot apply: a wildcard has no single name
  // to require, and registration rejects the key.
  for (const [name, { entry, loc }] of wildcardMatches) {
    const range = attributeTagOccurrenceRange(tree, name);
    if (entry.repeatable !== true && range.max > 1) {
      const occurrences = tags.filter((tag) => tag.name === name);
      failForOwner(
        REPEATED_ATTRIBUTE_TAG_CODE,
        owner,
        `${voice.attributeTag} ${voice.attrTag(name)} may not be repeated`,
        occurrences[1]?.loc ?? occurrences[0]?.loc ?? loc,
        undefined,
        occurrences.length > 0
          ? nameEndOf(occurrences[1] ?? occurrences[0])
          : locEnd,
      );
    }
  }
}

/**
 * What a call's checks know of the file's dialect: the keys it claims,
 * and where an error core queues behind the module's `afterLower` goes.
 */
export interface ClaimContext {
  claimed: ClaimedFields;
  defer(error: TranslateError): void;
  /** The words of the file's dialect in the messages; MX's own when absent. */
  voice?: Voice;
  /** The file's `structural` mode, when it is decided. */
  structural?: "pass" | "reject";
}

/** Does the declaration use a key the file's dialect claims? */
function usesClaimedKey(
  declaration: CustomTagAttribute,
  claimed: ClaimedFields,
): boolean {
  return Object.keys(declaration).some((key) => claimed.attribute.has(key));
}

/** The text of an attribute written as a plain string (not a node, not a member, not an expression), else undefined. */
function plainStringOf(attr: Attr): string | undefined {
  if (attr.kind === "static") {
    return dialectTypeOf(attr.node) || attr.member ? undefined : attr.value;
  }
  if (attr.kind !== "dynamic") return undefined;
  const node = withoutTsWrappers(attr.value.node);
  return node?.type === "StringLiteral" && !nodeOfForward(node)
    ? String(node.value)
    : undefined;
}

/**
 * What core's shape error says a node-type declaration accepts. Core reads no
 * key a module claims: a declaration that uses one is worded by the module's
 * `describeAttribute`, else not at all.
 */
function expectationOf(
  declaration: CustomTagAttribute,
  claimed: ClaimedFields | undefined,
): string {
  if (!claimed?.describe || !usesClaimedKey(declaration, claimed)) return "";
  const text = claimed.describe(frozenData({ ...declaration }));
  return typeof text === "string" ? text : "";
}

/**
 * Queues an error behind the dialect's `afterLower` (`ClaimContext`):
 * the first is raised once that hook has run without failing.
 */
export function raiseDeferredContractErrors(ctx: Ctx): void {
  const first = ctx.deferredContractErrors?.[0];
  if (first) throw first;
}

/** Enforces a tag's declared contracts before its transform runs. */
export function validateCustomTagCall(
  definition: CustomTag,
  call: TagCall,
  locate?: Locate,
  claims?: ClaimContext,
): void {
  const voice = claims?.voice ?? MX_VOICE;
  const owner = lazyOwner(() => tagLabelAt(call, voice));
  validateCustomTagChildren(
    definition,
    call,
    owner,
    nameEndOf(call),
    voice,
    claims?.structural === "reject",
  );
  if (definition.parseOptions?.openTagOnly && call.content) {
    failForOwner(
      CONTENT_NOT_ALLOWED_CODE,
      owner,
      "does not accept content",
      call.loc,
      undefined,
      nameEndOf(call),
    );
  }
  validateAttributes(
    owner,
    definition.attributes,
    call.attrs,
    call.loc,
    locate,
    claims,
    nameEndOf(call),
  );
  validateAttributeTags(
    owner,
    definition.attributeTags,
    call.attributeTags,
    call.attributeTagTree ?? directAttributeTagTree(call.attributeTags),
    call.loc,
    hasTemplate(definition),
    locate,
    claims,
    nameEndOf(call),
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
  subject: (name: string) => boolean = everyTag,
): void {
  if (!customTags) return;
  for (const [name, definition] of Object.entries(customTags)) {
    if (!subject(name)) continue;
    if (!definition.finalize) continue;
    if (definition.analyze || definition.transform || hasTemplate(definition)) {
      continue;
    }
    throw codedError(
      INVALID_CONTRACT_CODE,
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
] as const;
const CHILD_KEYS = ["repeatable", "required"] as const;
const ATTRIBUTE_TAG_KEYS = [
  ...CHILD_KEYS,
  "attributes",
  "attributeTags",
  "children",
  "defaultTag",
] as const;
/** An `attributeTags["*"]` entry: a pattern plus an inline contract; no `contract`, and no `required`. */
const WILDCARD_ATTRIBUTE_TAG_KEYS = [
  "pattern",
  ...ATTRIBUTE_TAG_KEYS.filter((key) => key !== "required"),
] as const;

const ITEM_TYPES = ["string", "number", "boolean"] as const;

/**
 * Rejects a declaration whose keys contradict each other, or that names a
 * node type the file's dialect does not register (`nodeTypes`, its
 * `dialect:Type` keys), at registration.
 */
function rejectContradictoryAttribute(
  owner: string,
  attrName: string,
  declaration: CustomTagAttribute,
  nodeTypes: ReadonlySet<string>,
): void {
  const reject = (code: MxDiagnosticCode, problem: string): never => {
    throw codedError(
      code,
      `Invalid "${attrName}" attribute declaration of ${owner}: ${problem}`,
      0,
      0,
    );
  };
  if (declaration.items !== undefined) {
    if (declaration.type !== "array") {
      reject(INVALID_CONTRACT_CODE, '`items` requires `type: "array"`');
    }
    if (
      !(ITEM_TYPES as readonly unknown[]).includes(declaration.items) &&
      !isNodeTypeKey(declaration.items)
    ) {
      reject(
        INVALID_CONTRACT_CODE,
        `\`items\` must be one of ${ITEM_TYPES.join(", ")}, or a node type key (\`dialect:Type\`)`,
      );
    }
  }
  for (const key of ["type", "items"] as const) {
    const type = declaration[key];
    if (isNodeTypeKey(type) && !nodeTypes.has(type)) {
      reject(
        INVALID_CONTRACT_CODE,
        `\`${key}: "${type}"\` is not a node type the file's dialect registers (${
          nodeTypes.size === 0
            ? "it registers none"
            : `it registers ${[...nodeTypes].map((each) => `\`${each}\``).join(", ")}`
        })`,
      );
    }
  }
  if (isNodeTypeKey(declaration.type) && declaration.enum !== undefined) {
    reject(
      INVALID_CONTRACT_CODE,
      `\`enum\` cannot be combined with \`type: "${declaration.type}"\``,
    );
  }
  if (
    declaration.enum &&
    (declaration.type === "array" || declaration.type === "function")
  ) {
    reject(
      INVALID_CONTRACT_CODE,
      `\`enum\` cannot be combined with \`type: "${declaration.type}"\``,
    );
  }
}

/**
 * The keys a `CustomTag` may state: the contract keys, the three hooks and
 * `template` (the file a tag file's template is). The one vocabulary every
 * contract source is held to (`customTags`, a sidecar, an `mx.contracts`
 * module, a dialect's `contracts`); the keys a file's dialect claims
 * (`contractFields.tag`) come on top, and `declares` has its own refusal.
 */
export const CUSTOM_TAG_KEYS = [
  "parseOptions",
  "attributes",
  "attributeTags",
  "children",
  "parents",
  "defaultTag",
  "analyze",
  "transform",
  "finalize",
  "template",
] as const;

/**
 * Where a source writes the key `key` of tag `tagName`'s definition, when it
 * can say: a sidecar's or an `mx.contracts` module's file, at the key. A
 * `customTags` object has no file to point at, so it passes none and the
 * refusal carries no position (line and column 0, no file), as every other
 * declaration refusal of that source does.
 */
export type LocateTagKey = (
  tagName: string,
  key: string,
) => (Position & { end?: { line: number; column: number } }) | undefined;

/**
 * Rejects a key `tagName`'s definition states that is not a `CustomTag` key
 * and that the file's dialect does not claim, naming the first one. A
 * misspelled `atributes` would otherwise register as a tag with no
 * attributes: its contract silently never applies. The attribute-level
 * wording (`Unknown key "k" in the … of tag "t"; allowed: …`), no code.
 * Shared by every contract source: registration reaches it through
 * {@link rejectUnknownDeclarationKeys}, and a source that allows fewer keys
 * than a `CustomTag` has (`mx.contracts`, a dialect's `contracts`) passes its
 * own `keys`, so the message lists what that source accepts.
 */
export function rejectUnknownTagKeys(
  tagName: string,
  definition: object,
  claimed: ClaimedFields = claimedFields(undefined),
  locate?: LocateTagKey,
  keys: readonly string[] = CUSTOM_TAG_KEYS,
): void {
  for (const key of Object.getOwnPropertyNames(definition)) {
    if (keys.includes(key)) continue;
    if (key === "declares" || claimed.tag.has(key)) continue;
    const at = locate?.(tagName, key);
    const allowed = [...new Set([...keys, ...claimed.tag])];
    const error = codedError(
      INVALID_CONTRACT_CODE,
      `Unknown key "${key}" in the declaration of tag "${tagName}"; allowed: ${allowed.join(", ")}`,
      at?.line ?? 0,
      at?.column ?? 0,
      at?.file,
    );
    if (at?.end) error.end = at.end;
    throw error;
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
  claimed: ClaimedFields = claimedFields(undefined),
  subject: (name: string) => boolean = everyTag,
  locate?: LocateTagKey,
): void {
  if (!customTags) return;
  for (const [tagName, definition] of Object.entries(customTags)) {
    if (!subject(tagName)) continue;
    rejectUnknownTagKeys(tagName, definition, claimed, locate);
    if (definition.children !== undefined) {
      for (const option of ["text", "openTagOnly"] as const) {
        if (definition.parseOptions?.[option] === true) {
          failAt(
            INVALID_CONTRACT_CODE,
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
            INVALID_CONTRACT_CODE,
            tagName,
            `child \`<${childName}>\` declares \`parents\` without \`<${tagName}>\`; add \`<${tagName}>\` to \`<${childName}>\`'s \`parents\`, or remove \`<${childName}>\` from \`<${tagName}>\`'s \`children\``,
            { line: 0, column: 0 },
          );
        }
        for (const key of Object.keys(declaration)) {
          if (!(CHILD_KEYS as readonly string[]).includes(key)) {
            throw codedError(
              INVALID_CONTRACT_CODE,
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
          INVALID_CONTRACT_CODE,
          tagName,
          `parent \`<${parentName}>\` declares \`children\` without \`<${tagName}>\`; add \`<${tagName}>\` to \`<${parentName}>\`'s \`children\`, or remove \`<${parentName}>\` from \`<${tagName}>\`'s \`parents\``,
          { line: 0, column: 0 },
        );
      }
    }
    rejectNonStringDefaultTag(`\`<${tagName}>\``, definition);
    if (Object.hasOwn(definition, "declares") && !claimed.tag.has("declares")) {
      failAt(
        INVALID_CONTRACT_CODE,
        tagName,
        `\`declares\` is not allowed: no syntax module claims it (\`contractFields\`)`,
        { line: 0, column: 0 },
      );
    }
    // A key the file's dialect claims is its data, not core's to
    // check: the module's `checkContract` checks it here, at registration.
    checkClaimedContract(tagName, definition, claimed);
    rejectRecursiveContractKeys(
      `tag "${tagName}"`,
      definition,
      `\`<${tagName}>\``,
      undefined,
      undefined,
      claimed.attribute,
      claimed.nodeTypes,
    );
  }
  for (const [tagName, definition] of Object.entries(customTags)) {
    if (!subject(tagName)) continue;
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
    if (name === WILDCARD || declaration === undefined) continue;
    const parentName = `@${name}`;
    const parentLabel = `\`<${parentName}>\``;
    const nestedOwner = `${owner}: ${parentLabel}`;
    const tagDeclaration = declaration as CustomTagAttributeTag;
    if (tagDeclaration.children !== undefined) {
      for (const [childName] of explicitChildEntries(tagDeclaration.children)) {
        const child =
          childName !== "#text" && Object.hasOwn(customTags, childName)
            ? customTags[childName]
            : undefined;
        if (
          child?.parents !== undefined &&
          !child.parents.includes(parentName)
        ) {
          failForOwner(
            INVALID_CONTRACT_CODE,
            nestedOwner,
            `child \`<${childName}>\` declares \`parents\` without ${parentLabel}; add ${parentLabel} to \`<${childName}>\`'s \`parents\`, or remove \`<${childName}>\` from ${nestedOwner}'s \`children\``,
            { line: 0, column: 0 },
          );
        }
      }
      for (const [childName, child] of Object.entries(customTags)) {
        if (
          child.parents?.includes(parentName) &&
          !hasExplicitChild(tagDeclaration.children, childName) &&
          !wildcardReferences(tagDeclaration.children, childName)
        ) {
          failAt(
            INVALID_CONTRACT_CODE,
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
      tagDeclaration.attributeTags,
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
  throw codedError(
    INVALID_CONTRACT_CODE,
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
  claimed: ReadonlySet<string> = new Set(),
  nodeTypes: ReadonlySet<string> = new Set(),
): void {
  const keys = (
    declaration:
      | CustomTagAttribute
      | CustomTagChild
      | CustomTagAttributeTag
      | WildcardChildEntry,
    allowed: readonly string[],
    description: string,
  ): void => {
    for (const key of Object.keys(declaration)) {
      if (!allowed.includes(key)) {
        throw codedError(
          INVALID_CONTRACT_CODE,
          `Unknown key "${key}" in the ${description} of ${owner}; allowed: ${allowed.join(", ")}`,
          0,
          0,
        );
      }
    }
  };
  const fail: (code: MxDiagnosticCode, message: string) => never = (
    code,
    message,
  ) => {
    throw codedError(code, message, 0, 0);
  };
  for (const [attrName, declaration] of Object.entries(
    definition.attributes ?? {},
  )) {
    keys(
      declaration,
      claimed.size === 0
        ? ATTRIBUTE_KEYS
        : [...new Set([...ATTRIBUTE_KEYS, ...claimed])],
      `"${attrName}" attribute declaration`,
    );
    rejectContradictoryAttribute(owner, attrName, declaration, nodeTypes);
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
        INVALID_CONTRACT_CODE,
        `${label}: \`children["*"]\` must be an entry object or a list of entry objects`,
      );
    }
    const entries = Array.isArray(value) ? value : [value];
    entries.forEach((entry: unknown, index) => {
      const at = `\`children["*"]\` entry ${index + 1}`;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        fail(INVALID_CONTRACT_CODE, `${label}: ${at} must be an object`);
      }
      const declared = entry as WildcardChildEntry;
      keys(declared, WILDCARD_ENTRY_KEYS, at);
      if (declared.pattern !== undefined) {
        if (typeof declared.pattern !== "string") {
          fail(
            INVALID_CONTRACT_CODE,
            `${label}: ${at}: \`pattern\` must be a string`,
          );
        }
        try {
          entryRegExp(declared);
        } catch (error) {
          fail(
            INVALID_CONTRACT_CODE,
            `${label}: ${at} has an invalid \`pattern\` ${JSON.stringify(declared.pattern)}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const inline = INLINE_CONTRACT_KEYS.filter((key) =>
        Object.hasOwn(declared, key),
      );
      if (declared.contract !== undefined) {
        if (typeof declared.contract !== "string" || declared.contract === "") {
          fail(
            INVALID_CONTRACT_CODE,
            `${label}: ${at}: \`contract\` must be a non-empty tag name`,
          );
        }
        if (inline.length > 0) {
          fail(
            INVALID_CONTRACT_CODE,
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
          INVALID_CONTRACT_CODE,
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
        claimed,
        nodeTypes,
      );
      path.delete(declared);
    });
  }
  for (const [name, declaration] of Object.entries(
    definition.attributeTags ?? {},
  )) {
    if (name === WILDCARD || declaration === undefined) continue;
    const named = declaration as CustomTagAttributeTag;
    keys(named, ATTRIBUTE_TAG_KEYS, `"${name}" attribute tag declaration`);
    rejectNonStringDefaultTag(`${owner}: \`<@${name}>\``, named);
    if (path.has(named)) {
      fail(
        INVALID_CONTRACT_CODE,
        `${label}: \`<@${name}>\`: an attribute-tag declaration contains itself`,
      );
    }
    path.add(named);
    rejectRecursiveContractKeys(
      `${owner}: "<@${name}>"`,
      named,
      `${label}: \`<@${name}>\``,
      root,
      path,
      claimed,
      nodeTypes,
    );
    path.delete(named);
  }
  if (
    definition.attributeTags &&
    Object.hasOwn(definition.attributeTags, WILDCARD)
  ) {
    const value: unknown = definition.attributeTags[WILDCARD];
    if (value === null || typeof value !== "object") {
      fail(
        INVALID_CONTRACT_CODE,
        `${label}: \`attributeTags["*"]\` must be an entry object or a list of entry objects`,
      );
    }
    const entries = Array.isArray(value) ? value : [value];
    entries.forEach((entry: unknown, index) => {
      const at = `\`attributeTags["*"]\` entry ${index + 1}`;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        fail(INVALID_CONTRACT_CODE, `${label}: ${at} must be an object`);
      }
      const declared = entry as WildcardAttributeTagEntry;
      keys(declared, WILDCARD_ATTRIBUTE_TAG_KEYS, at);
      if (declared.pattern !== undefined) {
        if (typeof declared.pattern !== "string") {
          fail(
            INVALID_CONTRACT_CODE,
            `${label}: ${at}: \`pattern\` must be a string`,
          );
        }
        try {
          entryRegExp(declared);
        } catch (error) {
          fail(
            INVALID_CONTRACT_CODE,
            `${label}: ${at} has an invalid \`pattern\` ${JSON.stringify(declared.pattern)}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      // An entry is always an inline contract (no `contract` key), so the one
      // cycle registration must refuse is self-containment.
      if (path.has(declared)) {
        fail(
          INVALID_CONTRACT_CODE,
          `${root}: \`attributeTags["*"]\` holds an entry that contains itself`,
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
        claimed,
        nodeTypes,
      );
      path.delete(declared);
    });
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
  subject: (name: string) => boolean = everyTag,
): void {
  if (!customTags) return;
  const fail: (code: MxDiagnosticCode, message: string) => never = (
    code,
    message,
  ) => {
    throw codedError(code, message, 0, 0);
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
          INVALID_CONTRACT_CODE,
          `${label}: ${at} references \`contract: ${JSON.stringify(entry.contract)}\`, which is not a tag reachable from this compile`,
        );
      }
      for (const option of ["text", "preserveWhitespace"] as const) {
        if (referenced.parseOptions?.[option] === true) {
          fail(
            INVALID_CONTRACT_CODE,
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
          INVALID_CONTRACT_CODE,
          `${label}: \`children["*"]\` references \`<${entry.contract}>\`, which declares \`parents\` without \`<${parentName}>\`; add \`<${parentName}>\` to \`<${entry.contract}>\`'s \`parents\`, or remove the reference`,
        );
      }
    });
    for (const [name, nested] of Object.entries(
      declaration.attributeTags ?? {},
    )) {
      if (name === WILDCARD || nested === undefined) continue;
      visit(
        `${label}: \`<@${name}>\``,
        nested as CustomTagAttributeTag,
        `@${name}`,
        seen,
      );
    }
    // An `attributeTags["*"]` entry is always an inline contract: no name of
    // its own to check `parents` against, but its nested contracts recurse.
    attributeTagWildcardEntries(declaration.attributeTags).forEach(
      (entry, index) => {
        visit(
          `${label}: \`attributeTags["*"]\` entry ${index + 1}`,
          entry,
          undefined,
          seen,
        );
      },
    );
  };
  for (const [tagName, definition] of Object.entries(customTags)) {
    if (!subject(tagName)) continue;
    visit(`\`<${tagName}>\``, definition, tagName, new Set());
  }
}

/** The registration checks' default subject: every tag in the map. */
function everyTag(): boolean {
  return true;
}

/**
 * Entries whose contract registration does not read (a dialect tag file:
 * reading it needs the dialect). Internal: a brand, never a field.
 */
const deferredEntries = new WeakSet<CustomTag>();

/**
 * How a deferred entry's contract is read when its getters are not the
 * source (a dialect tag file: `tag-file.ts` runs the dialect's hook).
 * Internal.
 */
export interface DeferredReader {
  /**
   * The contract, or why it cannot be read, plus warnings to report at the
   * caller. `call` is a read for a call of this tag (a cycle there is an
   * error); any other read is a check reading the contract.
   */
  read(call: boolean): DeferredRead;
  /**
   * Whether a read this entry already answered may no longer hold (a file
   * it depends on changed): registration then drops the view built on it.
   * `pass` is one object per sweep over a map's readers, so what one reader
   * learned (a directory's scan) is not re-checked by the next.
   */
  stale(pass?: object): boolean;
  /** The file that defines the tag, for `DelegatedTag.definedIn`. */
  readonly definedIn?: string;
}

/** What a {@link DeferredReader} answers. Internal. */
export interface DeferredRead {
  readonly contract?: CustomTag;
  readonly error?: unknown;
  readonly warnings?: readonly MxWarning[];
  /**
   * The read could not be answered now (a check reading a tag file whose
   * derivation is in progress): its contract keys answer absent, and no
   * check result built on it is kept.
   */
  readonly incomplete?: true;
  /** The answer is not cached by the reader (a cycle): nothing built on it is kept either. */
  readonly uncached?: true;
}

const readers = new WeakMap<CustomTag, DeferredReader>();

/**
 * Brands `definition` as a deferred-contract entry (see {@link registrationView}).
 * With `reader`, its contract is what the reader answers; without, its own
 * keys (getters) are read.
 */
export function deferContract(
  definition: CustomTag,
  reader?: DeferredReader,
): CustomTag {
  deferredEntries.add(definition);
  if (reader) readers.set(definition, reader);
  return definition;
}

/** The contract keys a deferred entry reads on first use; hooks, `parseOptions` and `template` are read as they are. */
const DEFERRED_KEYS = [
  "attributes",
  "attributeTags",
  "children",
  "parents",
  "defaultTag",
] as const;

/**
 * A deferred entry's raw contract, read once (phase 1): the entry's own
 * keys copied, or why reading them failed. No check runs here and nothing
 * else in the map is read, so a read never re-enters another.
 */
interface ContractRead {
  contract?: CustomTag;
  error?: unknown;
  warnings?: readonly MxWarning[];
}

const contractReads = new WeakMap<CustomTag, ContractRead>();

/** A reader's answer joined with the entry's own keys, per answer. */
const joinedReads = new WeakMap<DeferredRead, ContractRead>();

/**
 * Bumped whenever a read answers incomplete or uncached: a check that saw
 * it is not cached (a later call checks again against the full answer).
 */
let unsettledReads = 0;

function readContract(raw: CustomTag, call = false): ContractRead {
  const reader = readers.get(raw);
  if (reader) return readThrough(raw, reader, call);
  const known = contractReads.get(raw);
  if (known) return known;
  let read: ContractRead;
  try {
    const contract: CustomTag = {};
    for (const key of Object.keys(raw)) {
      const value = (raw as Record<string, unknown>)[key];
      if (value !== undefined) {
        (contract as Record<string, unknown>)[key] = value;
      }
    }
    read = { contract };
  } catch (error) {
    read = { error };
  }
  contractReads.set(raw, read);
  return read;
}

/**
 * A reader's answer as a contract: the entry's own keys other than its
 * contract's (`parseOptions`, a paired sidecar's hooks), then every key the
 * reader's contract has, so the registration checks see each of them.
 */
function readThrough(
  raw: CustomTag,
  reader: DeferredReader,
  call: boolean,
): ContractRead {
  const answer = reader.read(call);
  if (answer.incomplete || answer.uncached) unsettledReads++;
  const known = joinedReads.get(answer);
  if (known) return known;
  let read: ContractRead;
  if (answer.incomplete) {
    read = {};
  } else if (answer.error !== undefined || !answer.contract) {
    read = {
      error: answer.error,
      ...(answer.warnings ? { warnings: answer.warnings } : {}),
    };
  } else {
    try {
      const contract: CustomTag = {};
      for (const key of Object.keys(raw)) {
        if (Object.hasOwn(answer.contract, key) || isContractKey(raw, key)) {
          continue;
        }
        const value = (raw as Record<string, unknown>)[key];
        if (value !== undefined) {
          (contract as Record<string, unknown>)[key] = value;
        }
      }
      Object.assign(contract, answer.contract);
      read = {
        contract,
        ...(answer.warnings ? { warnings: answer.warnings } : {}),
      };
    } catch (error) {
      read = { error };
    }
  }
  joinedReads.set(answer, read);
  return read;
}

/** Whether `key` of a reader entry is one of its contract's getters. */
function isContractKey(raw: CustomTag, key: string): boolean {
  return (
    (DEFERRED_KEYS as readonly string[]).includes(key) ||
    (contractKeysOf.get(raw)?.has(key) ?? false)
  );
}

/** A reader entry's claimed contract keys (beyond core's), as the scan defined them. */
const contractKeysOf = new WeakMap<CustomTag, ReadonlySet<string>>();

/**
 * Records which of a reader entry's keys are contract getters (core's and
 * the claimed ones), so a read never runs them for their value. Internal.
 */
export function markContractKeys(
  raw: CustomTag,
  keys: readonly string[],
): void {
  contractKeysOf.set(raw, new Set(keys));
}

/** The file that defines `definition` (a view entry or a raw one), when a reader names one. */
export function definedInOf(definition: CustomTag): string | undefined {
  const raw = viewEntries.get(definition)?.raw ?? definition;
  return readers.get(raw)?.definedIn;
}

/**
 * The warnings a deferred entry's read carries (a tag file's own), for the
 * call that reads it to report. Empty for an eager entry.
 */
export function deferredContractWarnings(
  definition: CustomTag,
): readonly MxWarning[] {
  const raw = viewEntries.get(definition)?.raw ?? definition;
  if (!readers.has(raw)) return [];
  return readContract(raw, true).warnings ?? [];
}

/**
 * Whether any reader entry of `customTags` answered a read that may no
 * longer hold. Every reader is asked (each drops its own stale answer).
 */
function anyStaleReader(
  customTags: Readonly<Record<string, CustomTag>>,
): boolean {
  let stale = false;
  const pass = {};
  for (const name of Object.keys(customTags)) {
    const reader = readers.get(customTags[name] as CustomTag);
    if (reader?.stale(pass)) stale = true;
  }
  return stale;
}

/**
 * Why a called deferred entry fails (phase 2), cached per view entry: the
 * checks read the rest of the map, so one entry in two maps can fail two
 * ways. `undefined` when it reads and checks clean.
 */
const checkResults = new WeakMap<ViewEntry, { error?: unknown }>();

/** A view entry's origin: the deferred entry, its name, and the view it is in. */
interface ViewEntry {
  readonly raw: CustomTag;
  readonly name: string;
  readonly view: Readonly<Record<string, CustomTag>>;
  readonly claimed: ClaimedFields;
}

const viewEntries = new WeakMap<CustomTag, ViewEntry>();
const views = new WeakMap<
  Readonly<Record<string, CustomTag>>,
  WeakMap<ClaimedFields, Readonly<Record<string, CustomTag>>>
>();
/**
 * Per view, the map registration checks: each deferred entry reduced to
 * what registration reads without its contract (its name, `parseOptions`,
 * `template` and hooks), so a cross-tag check from an eager entry finds the
 * deferred one's contract keys absent and reads nothing.
 */
const registrationMaps = new WeakMap<
  Readonly<Record<string, CustomTag>>,
  Readonly<Record<string, CustomTag>>
>();

/** Whether `definition` is a deferred entry, raw or in a view (internal). */
export function isDeferredContract(definition: unknown): boolean {
  return (
    typeof definition === "object" &&
    definition !== null &&
    (deferredEntries.has(definition as CustomTag) ||
      viewEntries.has(definition as CustomTag))
  );
}

function registrationMapOf(
  view: Readonly<Record<string, CustomTag>>,
): Readonly<Record<string, CustomTag>> {
  const known = registrationMaps.get(view);
  if (known) return known;
  const map: Record<string, CustomTag> = Object.create(
    Object.getPrototypeOf(view),
  );
  for (const name of Object.keys(view)) {
    const definition = view[name] as CustomTag;
    const entry = viewEntries.get(definition);
    map[name] = entry ? withoutContract(entry) : definition;
  }
  registrationMaps.set(view, map);
  return map;
}

/** A deferred entry's keys other than its contract's, read as they are. */
function withoutContract(entry: ViewEntry): CustomTag {
  const stub: CustomTag = {};
  const deferred = deferredKeysOf(entry.claimed);
  for (const key of Object.keys(entry.raw)) {
    if (deferred.has(key)) continue;
    Object.defineProperty(stub, key, {
      enumerable: true,
      configurable: true,
      get: () => (entry.raw as Record<string, unknown>)[key],
    });
  }
  return stub;
}

function deferredKeysOf(claimed: ClaimedFields): Set<string> {
  return new Set<string>([...DEFERRED_KEYS, ...claimed.tag]);
}

/**
 * The registration checks a called deferred entry owes (phase 2), run once
 * per view entry and never throwing; a failure is recorded for the call to
 * raise. Two passes:
 *
 * - its own checks (unknown keys, wildcard references, unreachable hooks)
 *   over the view, where every other deferred entry answers with its raw
 *   contract (phase 1), as registration would read it eagerly;
 * - the eager entries' checks again, over the registration map with this
 *   one entry readable, for the cross-tag checks (`children`, `parents`,
 *   `children["*"]`, attribute-tag `children`) that name it.
 *
 * Neither pass reads another entry's checks, so nothing re-enters.
 */
function checkDeferred(entry: ViewEntry): { error?: unknown } {
  const known = checkResults.get(entry);
  if (known) return known;
  let result: { error?: unknown };
  const unsettled = unsettledReads;
  const read = readContract(entry.raw, true);
  if (read.error !== undefined || !read.contract) {
    result = { error: read.error };
  } else {
    try {
      const own = { ...entry.view, [entry.name]: read.contract };
      const only = (name: string) => name === entry.name;
      rejectUnknownDeclarationKeys(own, entry.claimed, only);
      rejectWildcardReferences(own, only);
      rejectUnreachableHooks(own, only);
      const registration = registrationMapOf(entry.view);
      const cross = { ...registration, [entry.name]: read.contract };
      const eager = (name: string) =>
        !viewEntries.has(entry.view[name] as CustomTag);
      rejectUnknownDeclarationKeys(cross, entry.claimed, eager);
      rejectWildcardReferences(cross, eager);
      rejectUnreachableHooks(cross, eager);
      result = {};
    } catch (error) {
      result = { error };
    }
  }
  // A read answered incomplete or uncached (a tag file mid-derivation, a
  // cycle): this result is not final, so a later call checks again.
  if (unsettledReads === unsettled) checkResults.set(entry, result);
  return result;
}

/**
 * The map lowering reads, for `customTags`: the map itself when no entry is
 * deferred (nothing changes), else a copy in which each deferred entry (see
 * {@link deferContract}) is a view whose contract keys read the entry's raw
 * contract on first use ({@link readContract}) and answer `undefined` when
 * that read fails, so a lookup never throws for a tag nobody called. Its
 * name, `parseOptions`, `template` and hooks are the entry's own. Cached per
 * map and claim. Registration checks a different map
 * ({@link rejectRegistration}), in which no deferred contract is read.
 */
export function registrationView(
  customTags: Readonly<Record<string, CustomTag>>,
  claimed: ClaimedFields,
): Readonly<Record<string, CustomTag>>;
export function registrationView(
  customTags: Readonly<Record<string, CustomTag>> | undefined,
  claimed: ClaimedFields,
): Readonly<Record<string, CustomTag>> | undefined;
export function registrationView(
  customTags: Readonly<Record<string, CustomTag>> | undefined,
  claimed: ClaimedFields,
): Readonly<Record<string, CustomTag>> | undefined {
  if (!customTags) return customTags;
  let byClaim = views.get(customTags);
  // A reader's answer can go stale with no change to this map (a file the
  // tag file depends on was edited): the views built on it, with their
  // cached checks, are dropped, and the next call reads afresh. Every call
  // asks, a map with no view yet included: a copy of a scanned map shares
  // its readers, and their answers.
  if (anyStaleReader(customTags) && byClaim) {
    views.delete(customTags);
    byClaim = undefined;
  }
  const known = byClaim?.get(claimed);
  if (known) return known;
  const names = Object.keys(customTags);
  if (!names.some((name) => deferredEntries.has(customTags[name] as CustomTag)))
    return customTags;
  const view: Record<string, CustomTag> = Object.create(
    Object.getPrototypeOf(customTags),
  );
  const deferred = deferredKeysOf(claimed);
  for (const name of names) {
    const raw = customTags[name] as CustomTag;
    if (!deferredEntries.has(raw)) {
      view[name] = raw;
      continue;
    }
    const wrapper: CustomTag = {};
    const entry: ViewEntry = { raw, name, view, claimed };
    for (const key of Object.keys(raw)) {
      if (deferred.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor) continue;
      Object.defineProperty(wrapper, key, {
        enumerable: true,
        configurable: true,
        get: () => (raw as Record<string, unknown>)[key],
      });
    }
    for (const key of deferred) {
      if (!Object.hasOwn(raw, key)) continue;
      Object.defineProperty(wrapper, key, {
        enumerable: true,
        configurable: true,
        get: () =>
          (readContract(raw).contract as Record<string, unknown>)?.[key],
      });
    }
    viewEntries.set(wrapper, entry);
    view[name] = wrapper;
  }
  if (!byClaim) {
    byClaim = new WeakMap();
    views.set(customTags, byClaim);
  }
  byClaim.set(claimed, view);
  return view;
}

/**
 * Why a deferred entry's contract cannot be read or fails its checks, read
 * on the call that needs it: `undefined` for an eager entry or a contract
 * that reads and checks clean. `definition` is a view entry, or a raw
 * deferred entry a caller registered without a view (then `customTags`
 * gives its view).
 */
export function deferredContractError(
  definition: CustomTag,
  name: string,
  customTags: Readonly<Record<string, CustomTag>> | undefined,
  claimed: ClaimedFields,
): unknown {
  let entry = viewEntries.get(definition);
  if (!entry && deferredEntries.has(definition)) {
    const view = registrationView(
      customTags && customTags[name] === definition
        ? customTags
        : { [name]: definition },
      claimed,
    );
    entry = viewEntries.get(view[name] as CustomTag);
  }
  if (!entry) return undefined;
  // A call reads the contract even when its check is cached, so a tag file
  // being derived records this one as a dependency.
  if (readers.has(entry.raw)) readContract(entry.raw, true);
  return checkDeferred(entry).error;
}

/**
 * The registration checks of `customTags`: eager entries as always, over a
 * map in which every deferred entry's contract is absent, so no check reads
 * one (their checks, both their own and the eager entries' that name them,
 * run on their first call, {@link deferredContractError}). Returns the
 * view, which is the map lowering reads.
 */
export function rejectRegistration(
  customTags: Readonly<Record<string, CustomTag>> | undefined,
  claimed: ClaimedFields,
): Readonly<Record<string, CustomTag>> | undefined {
  const view = registrationView(customTags, claimed);
  if (!view) return view;
  // A dialect contract its load validated under this claim passed these
  // checks already; the cross-tag check (`rejectWildcardReferences`) still
  // runs, since the other tags are this registration's.
  const unvalidated =
    (map: Readonly<Record<string, CustomTag>>) => (name: string) =>
      validatedContracts.get(map[name] as CustomTag) !== claimed;
  if (view === customTags) {
    const own = unvalidated(view);
    rejectUnknownDeclarationKeys(view, claimed, own);
    rejectWildcardReferences(view, everyTag);
    rejectUnreachableHooks(view, own);
    return view;
  }
  const registration = registrationMapOf(view);
  const eager = (name: string) => !viewEntries.has(view[name] as CustomTag);
  const isNew = unvalidated(registration);
  const own = (name: string) => eager(name) && isNew(name);
  rejectUnknownDeclarationKeys(registration, claimed, own);
  rejectWildcardReferences(registration, eager);
  rejectUnreachableHooks(registration, own);
  return view;
}

/**
 * Dialect contracts (`Dialect.contracts`) a dialect's load validated, with
 * the claim they were validated under. Registration skips their own checks
 * under that claim, so a contract is checked once per module revision, not
 * once per compile; the same object registered under another claim (passed
 * as `customTags` to a file of no dialect) is checked as any definition.
 */
const validatedContracts = new WeakMap<CustomTag, ClaimedFields>();

/** Whether `contract` was validated as a dialect contract under `claimed`. */
export function isValidatedContract(
  contract: CustomTag,
  claimed: ClaimedFields,
): boolean {
  return validatedContracts.get(contract) === claimed;
}

/** Marks every entry of `contracts` validated under `claimed` (see {@link rejectRegistration}). */
export function markValidatedContracts(
  contracts: Readonly<Record<string, CustomTag>>,
  claimed: ClaimedFields,
): void {
  for (const name of Object.keys(contracts)) {
    validatedContracts.set(contracts[name] as CustomTag, claimed);
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
      fail: (message, options) =>
        failFromHook(
          ctx,
          spellAt(voiceOfCtx(ctx), name, first.loc),
          message,
          options,
          first.loc,
        ),
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
      throw wrapHookError(error, name, "analyze", first.loc, voiceOfCtx(ctx));
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
      throw wrapHookError(error, name, "finalize", loc, voiceOfCtx(ctx));
    }
    if (!Array.isArray(nodes)) {
      failAt(
        TAG_HOOK_ERROR_CODE,
        name,
        "`finalize` must return an array of IR nodes",
        loc,
        undefined,
        voiceOfCtx(ctx),
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
  voice: Voice = MX_VOICE,
): TranslateError {
  if (isTranslateError(error)) return error;
  return codedError(
    TAG_HOOK_ERROR_CODE,
    `${spellAt(voice, tagName, loc)}: custom tag \`${hook}\` threw: ${error instanceof Error ? error.message : String(error)}`,
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
 * `attrs` with every attribute the call did not write spanned where the
 * author's text ends the tag's name: zero-width, so it contains no position,
 * claims no authored text and sorts with the tag, never over a neighbour.
 *
 * A contract `default` is materialized after parsing and has no source of its
 * own, but the IR `lowerSource` returns promises a span on every attribute,
 * its name and its value (`SpannedIr`), and a transform's view of the same
 * attribute stays unspanned (`defaultAttr`). The authored attributes are
 * passed through untouched, by identity. A call without a `nameSpan` has no
 * source to anchor on and is returned as is.
 */
function spanDefaultedAttrs(
  attrs: Attr[],
  authored: readonly Attr[],
  nameSpan: SourceSpan | undefined,
): Attr[] {
  if (!nameSpan || attrs.length === authored.length) return attrs;
  const at = { sourceStart: nameSpan.sourceEnd, sourceEnd: nameSpan.sourceEnd };
  const written = new Set(authored);
  return attrs.map((attr) => {
    if (written.has(attr) || attr.kind === "spread") return attr;
    if (attr.kind === "static") {
      return { ...attr, nameSpan: at, valueSpan: at, span: at };
    }
    if (attr.kind === "dynamic") {
      return {
        ...attr,
        nameSpan: at,
        span: at,
        valueSpan: at,
        value: { ...attr.value, span: at },
      };
    }
    return attr;
  });
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
 * arguments ("Tag does not support arguments."), and attributes or nested
 * attribute tags on an attribute tag
 * ("`<tag>`: attribute tag `<@x>` does not support attributes" / "does not
 * support nested attribute tags").
 */
function contractOnlyDelegatedTag(
  ctx: Ctx,
  call: TagCall,
  authored: readonly Attr[],
  node: Node,
  definition: CustomTag,
): IrNode {
  const definedIn = definedInOf(definition);
  const attrs = spanDefaultedAttrs(call.attrs, authored, call.nameSpan);
  return {
    kind: "DelegatedTag",
    tag: {
      name: call.name,
      ...(definedIn !== undefined ? { definedIn } : {}),
      ...(call.alias ? { alias: call.alias } : {}),
      ...(call.trigger ? { trigger: call.trigger } : {}),
      nameSpan: call.nameSpan,
      span: call.span,
      attrs,
      args: [],
      children: call.content?.children ?? [],
      attributeTags: call.attributeTags,
      attributeTagTree:
        call.attributeTagTree ?? directAttributeTagTree(call.attributeTags),
      attrTagProps: call.attrTagProps ?? [],
      params: call.params,
      var: call.var,
      data: ctx.declarations.resolveDelegatedTag?.(
        call.name,
        markoViewOf(ctx, node),
        ctx,
      ),
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
  const voice = voiceOfCtx(ctx);
  const owner = lazyOwner(() => tagLabelAt(call, voice));
  if (!definition.transform && !hasTemplate(definition) && !contractOnly) {
    // An inline `children["*"]` contract can carry no transform: it is
    // validation-only, useful where the target delegates (data).
    const inline =
      call.alias !== undefined && call.alias.authored === call.name;
    failForOwner(
      UNSUPPORTED_CONSTRUCT_CODE,
      owner,
      inline
        ? `an inline \`children["*"]\` contract has no transform; on ${ctx.declarations.name ?? "this target"} a matched child needs \`contract:\` naming a tag with a transform or template`
        : "custom tag has neither a `transform` nor a template file, so a call has nothing to expand to",
      call.loc,
      undefined,
      nameEndOf(call),
    );
  }

  validateCustomTagCall(definition, call, (offset) => positionAt(ctx, offset), {
    voice,
    claimed: claimedFields(ctx.dialect),
    structural: ctx.structural,
    defer: (error) => {
      ctx.deferredContractErrors ??= [];
      ctx.deferredContractErrors.push(error);
    },
  });
  // Remembered for the module's `afterLower` (`LoweredUnit.calls`).
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
  if (contractOnly) {
    return [
      contractOnlyDelegatedTag(ctx, withDefaults, call.attrs, node, definition),
    ];
  }
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
      voice,
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
    fail: (message, options) =>
      failFromHook(
        ctx,
        owner,
        message,
        options,
        call.loc,
        coreOwnedTags.has(definition),
      ),
    gensym: (hint) => gensymFor(ctx, call.name, hint),
    store: storeFor(ctx, call.name),
  };
  transformVoices.set(tagContext, voice);

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
    // A core-owned tag spelling its message through the dialect's `formatTag`.
    if (error instanceof VoiceHookError) {
      throw codedError(
        DIALECT_HOOK_ERROR_CODE,
        error.message,
        call.loc.line,
        call.loc.column,
        call.loc.file,
      );
    }
    throw codedError(
      TAG_HOOK_ERROR_CODE,
      `${ownerText(owner)}: custom tag threw: ${error instanceof Error ? error.message : String(error)}`,
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
      TAG_HOOK_ERROR_CODE,
      owner,
      "custom tag transform must return an array of IR nodes or a TagCall for its template",
      call.loc,
      undefined,
      nameEndOf(call),
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
      message: `${ownerText(owner)}: custom tag transform did not read its attributeTags; authored ${voice.attributeTags} were dropped`,
      code: ATTRIBUTE_TAG_DROPPED_CODE,
      line: call.loc.line,
      column: call.loc.column,
      ...callNameEnd(ctx, call),
      file: call.loc.file,
    });
  }
  return nodes;
}
