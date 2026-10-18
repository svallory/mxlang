/**
 * Dialects: the dialect a file is parsed and lowered with (its syntax table,
 * hooks and node types), loaded from the package that claims the file's
 * extension (`dialect-discovery.ts`), and the check that keeps a table core
 * cannot lower yet from compiling silently.
 *
 * The table is plain data (`@mxlang/parser`'s `SyntaxTable`); the types are
 * declared here because the published `.d.ts` may not name the private
 * `@mxlang/parser` (a test in `@mxlang/parse-differential` pins the two
 * declarations equal). This is the interim until the MX front end is bundled
 * into core (parser port PR 4).
 */
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import {
  type ContractCheckContext,
  type ContractFields,
  checkContractFields,
  forgetClaimedFields,
  registerSyntaxResolver,
} from "./contract-fields.ts";
import type { Node } from "./core.ts";
import { codedError, isTranslateError, type TranslateError } from "./core.ts";
import type { ContractMap, CustomTag, IrBuilders } from "./custom-tags.ts";
import { isDeepFrozen } from "./deep-frozen.ts";
import {
  effectiveDiagnosticCodes,
  INVALID_CONFIG_CODE,
  INVALID_DIALECT_CONTRACT_CODE,
  INVALID_DIALECT_MODULE_CODE,
  isMxDiagnosticCode,
  isReservedHookCode,
  MODULE_LOAD_FAILED_CODE,
  type MxDiagnosticCode,
  NO_LOWERING_CODE,
  RESERVED_TAG_CODE,
  reservedHookCodeMessage,
  UNRENAMEABLE_CODES,
} from "./diagnostic-codes.ts";
import {
  type ContractFail,
  checkDialectContracts,
  isMergedContracts,
  withDialectContracts,
} from "./dialect-contracts.ts";
import {
  type DialectManifest,
  discoverDialects,
  type RouteDialectOptions,
  routeDialect,
} from "./dialect-discovery.ts";
import {
  findCoreMarkClash,
  findMarkOverlap,
  type MarkOverlap,
} from "./dialect-marks.ts";
import {
  checkDialectNodeTypes,
  forgetNodeTypeRegistry,
  isCallRow,
  isNodeTypeRow,
  type NodeType,
  rowKey,
  TRIGGER_KEY,
  unregisteredNodeRow,
} from "./dialect-registry.ts";
import { findNearestPackageJson } from "./host-policy.ts";
import type { IrNode, TagTrigger } from "./ir.ts";
import type { ContractData, LoweredUnit } from "./lowered-unit.ts";
import type { SourceSpan } from "./mapping.ts";
import type {
  TagFileContext,
  TagFileInput,
  TagFileResult,
} from "./tag-file.ts";

export type {
  ContractCheckContext,
  ContractData,
  ContractFields,
  LoweredUnit,
  SourceSpan,
};

import { type MxTemplateParser, mxTemplateParser } from "./marko-frontend.ts";
import { findMxConfig, type MxConfigSource } from "./mx-config.ts";
import { filePosition } from "./mx-parse.ts";
import { jsonKeyPosition, readPackageJsonCached } from "./package-json.ts";
import {
  loadDefaultExport,
  mxKeyPosition,
  staticKeyPathPosition,
} from "./scan.ts";
import { dialectReservedMessage } from "./tag-names.ts";
import { TAG_RULES_PRESETS, type TagRulesPreset } from "./tag-presets.ts";
import { triggerRow } from "./triggers.ts";

/** What the expression parser reads in place of a trigger's text, always of the same length. */
export type StandIn = "number" | "identifier" | "keep";

/**
 * What core builds from a trigger. The built-in kinds lower in core with no
 * hook: in an expression, `"string"` is a string literal of the trigger's
 * text and `"identifier"` an identifier named by it; in an attribute list,
 * `"attribute"` is an attribute named by the text after its first
 * character, the sigil (bare, or with its `=value`). Any other pairing is a positioned error. `{ call }` hands the
 * trigger to the dialect's `lowerTrigger`. `{ type, dialect }` names a
 * registered node type: one of the dialect's
 * `nodeTypes`, or core's `mx:Trigger` (what `{ call }`
 * and `"attribute"` are, attribute and line rows only) or `mx:Expression`.
 * The row's `match` decides where the text ends; the parser asks the type's
 * `parse` to claim it, and a declined text parses as if no row matched. A
 * claimed node stays in the tree at its position and its type's `lower`
 * builds it; in an expression it lowers to an expression, its forward, and
 * `Expr.nodes` keeps the node beside it. A value row's `match` covers the
 * whole value.
 */
export type TriggerNode =
  | "string"
  | "identifier"
  | "attribute"
  | { readonly call: string }
  | { readonly type: string; readonly dialect: string };

/** One row of a trigger list. */
export interface Trigger {
  readonly id: string;
  readonly chars: string;
  readonly match: string;
  readonly standIn: StandIn;
  readonly node: TriggerNode;
  readonly terminatesValue?: boolean;
  /**
   * Attribute triggers: `"refuse"` makes a `=value`, `:=value` or
   * `(params) { body }` after the trigger a parser error at that character
   * (`tag #id=123` is refused). Absent, the trigger takes one.
   */
  readonly value?: "refuse";
}

/** The syntax table: one plain-data object per parse
 * (`language-extensions/core.md`).
 */
export interface SyntaxTable {
  readonly placeholder: {
    readonly open: string;
    readonly close: string;
  } | null;
  readonly inlineScript: { readonly trigger: string } | null;
  readonly blockTag: { readonly open: string; readonly close: string } | null;
  readonly filter: { readonly open: string; readonly close: string } | null;
  readonly concise: boolean;
  /**
   * Whether a tag head has the `#id` and `.class` shorthands
   * and the implicit `div`. Default `true`. With `false`, a `.` continues the
   * tag name (`billing.InvoiceVoided` is one tag, concise and HTML, and
   * `</billing.InvoiceVoided>` closes it); a `#` anywhere in a tag head, and a
   * head that starts with `.` or `#`, is `MX_NO_TAG_SHORTHAND` at that
   * character; a trailing `.`, a doubled `..` or a `.` right after a `${…}`
   * is `MX_INVALID_TAG_NAME`. Omitted means `true`. Carried through
   * `syntaxHash`. @unstable
   */
  readonly tagShorthands?: boolean;
  readonly expressionTriggers: readonly Trigger[];
  readonly attributeTriggers: readonly Trigger[];
  readonly lineTriggers: readonly Trigger[];
  /**
   * Rows tried on an attribute's whole `=value`: the row armed on the
   * value's first character claims it when its `match` covers the whole
   * text and its node type's `parse` takes it. Each names a node type
   * (`{ type, dialect }`). Omitted means none.
   */
  readonly valueTriggers?: readonly Trigger[];
  readonly textTriggers: readonly Trigger[];
  /** Tag types by written name: html 0, text 1, void 2, statement 3 (the template parser's `TagType`). */
  readonly tagTypes: Readonly<Record<string, 0 | 1 | 2 | 3>>;
  readonly expressionLanguage: "ts";
}

/**
 * Where a trigger sits: the table list that armed it. `"value"` is a node
 * a value row claimed, lowered as an attribute's whole value.
 */
export type TriggerPosition = "expression" | "attribute" | "line" | "value";

/**
 * The positions a `{ call }` row lowers in, through `lowerTrigger`: a value
 * row always names a node type, so `lowerTrigger` never sees `"value"`.
 */
export type CallPosition = Exclude<TriggerPosition, "value">;

/**
 * An expression a trigger lowers to, built by `ctx.expression(node)`: a Babel
 * node that replaces the trigger's stand-in in the expression's payload (in
 * an expression), or an attribute's value. `ctx.value` is one too.
 */
export interface TriggerExpression {
  readonly kind: "expression";
  readonly node: object;
}

/**
 * A method value, `(params) { body }` written right after an attribute
 * trigger (`boolean :isOverdue() { … }`): `ctx.value` when the trigger has
 * one. It is opaque: a dialect places it with `ctx.attribute`, never builds
 * one. @unstable
 *
 * `async` is `true` when `async` is written before the trigger
 * (`kind async :name(p) { b }`): the method is an async function, and
 * `ctx.valueForm` is `"async-method"`. The `async` keyword is outside the
 * method's span (it starts at the method's `<` or `(`), so a placed value's
 * text never covers the trigger's own. A dialect that does not want async
 * methods refuses the form with `ctx.fail`; one that places it gets an
 * async `FunctionExpression`.
 */
export interface TriggerMethod {
  readonly kind: "method";
  readonly async: boolean;
}

/**
 * The value of an attribute `ctx.attribute` builds: `true` (a bare
 * attribute), a string, an expression, the trigger's own method value, a
 * member, or a node of one of the dialect's registered types.
 * `{ kind: "member", name }` is a whole-value member the module builds;
 * core has no syntax that builds one. A node (`{ type: "atom:Atom", span,
 * ...fields }`) lowers through its type's `lower` in value position, as a
 * node a value row claimed does, and stays on the IR beside what it lowered
 * to (`Attr.node`, or `Expr.nodes`); its `span` defaults to the part of the
 * trigger's text that spells the attribute. A node of a type the dialect
 * does not register is a positioned error. A value's `span` defaults to the
 * trigger's own.
 */
export type TriggerAttributeValue =
  | true
  | string
  | TriggerExpression
  | TriggerMethod
  | {
      readonly kind: "member";
      readonly name: string;
      readonly span?: SourceSpan;
    }
  | {
      /** The node's registry key; every field but `type` and `span` is its type's own. */
      readonly type: `${string}:${string}`;
      readonly span?: SourceSpan;
      readonly [field: string]: unknown;
    };

/**
 * How `ctx.attribute` places an attribute (all optional). @unstable
 *
 * - `authored`: the attribute is spelled by the trigger's text. A
 *   diagnostic names the text (`:email` for `name`), and a whole-value node
 *   so placed also satisfies a `string` or `enum` contract slot as the
 *   string it lowered to (spec §13.9.5). On the default value the
 *   trigger's own value sets, a contract's error says which trigger set it (`set by \`:n=…\``).
 * - `once`: a second attribute of the same name on the tag, written or
 *   built, is a positioned error with this message, at the later one. The
 *   default value is one name however it is written (`<x=1>`, `value=1`,
 *   `value:=y`). `{written}` in the message is the later attribute as
 *   written, `{first}` the earlier one's `line:column`.
 * - `at`: the part of the trigger's text that spells the attribute, where
 *   one trigger builds several (`#main.big:name`).
 */
export interface TriggerAttributeOptions {
  readonly authored?: boolean;
  readonly once?: string;
  /** The part of the trigger's text that spells this attribute (`:name` in `#m.big:name`); the whole text when absent. */
  readonly at?: SourceSpan;
}

/** How `ctx.fail` raises its error (all optional). @unstable */
export interface TriggerFailOptions {
  /** Where the error is, inside the document; the trigger's own span when absent. */
  readonly at?: SourceSpan;
  /** A machine-readable code, carried on the error as `diagnosticCode` (and on a data diagnostic as `code`). */
  readonly code?: string;
}

/**
 * A named attribute, built by `ctx.attribute(name, value)`. A `null` name is
 * the tag's default value (`<tag=value>`).
 */
export interface TriggerAttribute {
  readonly kind: "attribute";
  readonly name: string | null;
  readonly value: TriggerAttributeValue;
  readonly options?: TriggerAttributeOptions;
}

/**
 * A shorthand, built by `ctx.shorthand("id" | "class", name)`: exactly what
 * Marko's tag-adjacent `#name` / `.name` sets, with Marko's rules (one id, a
 * class merged with the tag's other classes in written order). @unstable
 */
export interface TriggerShorthand {
  readonly kind: "shorthand";
  readonly attribute: "id" | "class";
  readonly name: string;
}

/** A child tag of the enclosing body, built by `ctx.child(tagName, attrs)`. */
export interface TriggerChild {
  readonly kind: "child";
  readonly tagName: string;
  readonly attrs: readonly TriggerAttribute[];
}

/**
 * What `lowerTrigger` (or a node type's `lower`) returns, matching
 * `ctx.position`: an expression; an attribute or shorthand, or a non-empty
 * list of them (`:x() { … }` is a `name` and the default value); a child;
 * in value position the string every target emits (the IR keeps the node
 * beside it) or an expression.
 */
export type TriggerResult =
  | string
  | TriggerExpression
  | TriggerAttribute
  | TriggerShorthand
  | readonly (TriggerAttribute | TriggerShorthand)[]
  | TriggerChild;

/**
 * How an expression trigger's operand is used, for a dialect that refuses
 * some uses (an atom is a name, not a value to operate on): the object of a
 * member access, a callee (a tagged template's tag included), the operand
 * of a unary operator, a spread (`<div ...x/>` included), or a property
 * name (`{ x: 1 }`, `{ x }`). `null` for any other use. Core refuses a
 * property name after the hook returns, so a dialect may only refuse it in
 * its own words first. @unstable
 */
export type TriggerUse =
  | "member-object"
  | "callee"
  | "unary"
  | "spread"
  | "key"
  | null;

/** How a trigger's own value is written (`ctx.valueForm`). @unstable */
export type TriggerValueForm =
  | "="
  | ":="
  | "method"
  | "async-method"
  | "arguments"
  | null;

/**
 * What `lowerTrigger` is handed: where the trigger sits, its lowered `=value`,
 * and the three constructors, the only way a
 * dialect builds anything. Each position takes the matching result:
 * `"expression"` an expression (a `{ call }` row's trigger, or a node an
 * expression row claimed), `"attribute"` an attribute, `"line"` a child,
 * `"value"` (a node a value row claimed, or one `ctx.attribute` placed) the
 * string every target emits or an expression. Core gives the result its
 * positions from the trigger, or from the value.
 */
export interface TriggerContext {
  readonly position: TriggerPosition;
  /**
   * The `=value` of an attribute or line trigger, its own triggers already
   * lowered, or an attribute trigger's method value (`:x() { … }`); `null`
   * without one.
   */
  readonly value: TriggerExpression | TriggerMethod | null;
  /**
   * How an attribute or line trigger's own value is written: `=value`,
   * `:=value` (bound), a method (`(params) { body }`), an async method
   * (`async` written before the trigger: `async :name(params) { body }`),
   * or `(args)` with no body; `null` without one. A bound value or
   * arguments cannot be placed: core refuses them after the hook, which may
   * refuse first in its own words. @unstable
   */
  readonly valueForm: TriggerValueForm;
  /** How an expression trigger's operand is used (`null` elsewhere). @unstable */
  readonly use: TriggerUse;
  /** The operator when `use` is `"unary"` (`-`, `!`, `typeof`, …); `null` otherwise. @unstable */
  readonly operator: string | null;
  expression(node: object): TriggerExpression;
  attribute(
    name: string | null,
    value: TriggerAttributeValue,
    options?: TriggerAttributeOptions,
  ): TriggerAttribute;
  /** A shorthand id or class, as Marko's tag-adjacent `#name` / `.name`. @unstable */
  shorthand(attribute: "id" | "class", name: string): TriggerShorthand;
  child(tagName: string, attrs: readonly TriggerAttribute[]): TriggerChild;
  /**
   * A positioned error in the dialect's own words, at the trigger or at
   * `at` (a span inside the document), carrying `code` when given.
   * @unstable
   */
  fail(message: string, options?: TriggerFailOptions): never;
}

/**
 * A tag the file's author wrote that has no contract, as
 * `Dialect.explainUnknownTag` sees it. The same view on both paths core finds
 * unknown tags on (a source that lowers and one whose lowering failed).
 * @unstable
 */
export interface UnknownTag {
  /** The name as written: a colon is part of it (`uuid:id`, `:x`). An unnamed tag (`<#a>`) is the default tag it resolves to. */
  readonly name: string;
  /**
   * The name's span (`uuid:id` in `<uuid:id/>`): file-absolute UTF-16
   * offsets. An unnamed tag (`<#a>`) has no name in the source: its span is
   * empty, at the character after the `<`.
   */
  readonly nameSpan: SourceSpan;
  /** The whole element, body and closing tag included. */
  readonly span: SourceSpan;
  /**
   * The authored tags around it, outermost first, ending with its direct
   * parent; `[]` at the top level. An attribute tag is named `@row`.
   * Control flow (`<if>`, `<for>`) is not a tag here.
   */
  readonly ancestors: readonly UnknownTagAncestor[];
  /** The effective `unknownTags`: the call's, else the dialect's, else `"allow"`. */
  readonly mode: "allow" | "reject";
  readonly file: string;
  readonly source: string;
}

/** One authored tag around an {@link UnknownTag}. @unstable */
export interface UnknownTagAncestor {
  /**
   * The name as written (`@row` for an attribute tag). A dynamic tag
   * (`<${expr}>`, always an error in a data file) is `""`, and its `nameSpan` is
   * the expression.
   */
  readonly tag: string;
  /** Where the name is written; absent for a tag a `transform` built. */
  readonly nameSpan?: SourceSpan;
  /** Its contract as plain data, absent for a tag with none. */
  readonly contract?: ContractData;
}

/** What `Dialect.explainUnknownTag` returns to explain a tag. @unstable */
export interface UnknownTagExplanation {
  /** Non-empty. */
  readonly message: string;
  /** Carried to `IrDiagnostic.code`: the dialect's own namespace, never `MX_`. */
  readonly code?: string;
  /**
   * Where the error is, a span inside the document (core computes the line
   * and column). Default: where core reports the tag, its start.
   */
  readonly at?: SourceSpan;
}

/**
 * A tag as a message names it, handed to `MessageVocabulary.formatTag`.
 * @unstable
 */
export interface MessageTag {
  /**
   * The name core has: the lowered one (`member`), never undefined. For a
   * dynamic tag, its expression source (`x` in `<${x}/>`).
   */
  readonly name: string;
  /**
   * How the head is written, not what it resolves to. `"tag"` for any head
   * written as a name (a capitalized name the file binds included, `name` as
   * written), `"attributeTag"` for an `@name` attribute tag (`name` has no
   * `@`), `"dynamic"` only for a head that is an expression (`<${x}/>`).
   */
  readonly form: "tag" | "attributeTag" | "dynamic";
  /**
   * Set when the dialect's own `lowerTrigger` made this tag (`ctx.child`);
   * `trigger.text` is what the user wrote (`&title`). Absent on a tag the
   * user wrote as a tag.
   */
  readonly trigger?: TagTrigger;
}

/**
 * The words core's messages use for a dialect's files where MX's own would
 * read wrong. Every member is optional; MX's wording is the default, so a
 * dialect that sets none keeps every message as it is. Core words the messages
 * a dialect file's author reaches, including those about MX's built-in tags
 * (`<for>`, `<script>`, ...): they name the tag through `formatTag` like any
 * other, and a syntax example written in MX's tags (`<const/name=value/>`) is
 * shown only when the file spells that tag as MX does. The text a dialect
 * author reads when a contract is registered keeps MX's words. @unstable
 */
export interface MessageVocabulary {
  /**
   * What the dialect calls MX's "attribute" (`key=value` on a tag), in both
   * numbers: `{ one: "option", many: "options" }`. Both are non-empty single
   * words or phrases without backticks. `article` is the indefinite article
   * `one` takes ("an option"); without it core picks "an" before a vowel
   * letter and "a" otherwise. Default: `attribute` / `attributes`.
   */
  readonly attribute?: {
    readonly one: string;
    readonly many: string;
    readonly article?: "a" | "an";
  };
  /**
   * What the data-file checks call the file: "a data file", and in the plural
   * "Data files are static, so they do not evaluate `<if>`". A noun phrase
   * without backticks. Either a string, whose plural is the string plus "s"
   * (`"Kit file"` and `"Kit files"`), or `{ one, many, article? }` for a
   * plural that is not that (`{ one: "index", many: "indices" }`). `article` is
   * the indefinite article `one` takes, as for `attribute`. The plural is
   * capitalised where a message starts with it. Default: `data file`.
   */
  readonly file?:
    | string
    | {
        readonly one: string;
        readonly many: string;
        readonly article?: "a" | "an";
      };
  /**
   * Unused: no message reads it any more, because the static-file messages
   * say "<Files> are static, so ..." with {@link MessageVocabulary.file}.
   * Still accepted and validated, so a dialect that states it keeps loading.
   * A noun phrase.
   */
  readonly tree?: string;
  /**
   * The bare spelling of a tag in a message; core wraps it in backticks.
   * Return `undefined` for core's own spelling (`<name>`, `<@name>`,
   * `<${expr}>`). Synchronous. A throw, or a return that is neither
   * `undefined` nor a non-empty single-line string without backticks, is
   * `MX_DIALECT_HOOK_ERROR` at the tag.
   */
  readonly formatTag?: (tag: MessageTag) => string | undefined;
}

/** What `lowerBlockTag` and `lowerFilter` get: the IR builders a custom tag's `transform` gets. */
export interface SyntaxBuildContext {
  readonly build: IrBuilders;
}

/**
 * A dialect: the default export of the module its package's
 * `package.json#mx.dialect` names, or the object a
 * consumer passes as the `dialect` option. A file is a dialect's when the
 * dialect claims its extension; a project may use several. `table`
 * overlays the `.mx` default row; the hooks are post-parse only
 * (`language-extensions/core.md`, "Hooks"); `nodeTypes` registers the
 * dialect's node types, keyed `id:Type` beside core's own (dialect zero).
 * @unstable
 */
export interface Dialect {
  /**
   * The dialect's identity (`mesh`): lower-case words joined by `-`, never
   * `mx` (MX's own). Its key in MX's config and the namespace of its node
   * types. A loaded dialect gets it from its manifest.
   */
  readonly id: string;
  /**
   * What tooling and core's diagnostics call the language (`Mesh`), where
   * MX's own files say "MX". A loaded dialect gets it from its manifest.
   */
  readonly name: string;
  readonly table: Partial<Omit<SyntaxTable, "tagTypes">>;
  /**
   * The core tag rules the dialect's files parse with: the dialect's own, in
   * every tool, and no project config changes them. Absent means `html`, the
   * full strict rules; a dialect turns off what it does not want by naming a
   * preset.
   */
  readonly tagRules?: TagRulesPreset;
  /**
   * The dialect's default for `lowerSource`'s `structural` option: `"reject"`
   * makes each structural construct (text, `${}`, `<if>`, `<for>`, `<const>`,
   * `import`, `export`, `static`) a positioned error in the dialect's files.
   * Absent means `"pass"`. A call that states `structural` wins.
   * @unstable
   */
  readonly structural?: "pass" | "reject";
  /**
   * The dialect's default for `lowerSource`'s `imports` option. Absent means
   * the effective `structural`. A call that states `imports` wins.
   * @unstable
   */
  readonly imports?: "pass" | "reject";
  /**
   * The dialect's default for `lowerSource`'s `unknownTags` option:
   * `"reject"` closes the vocabulary, so a tag with no contract is
   * `MX_UNKNOWN_TAG`. Absent means `"allow"`. A call that states
   * `unknownTags` wins.
   * @unstable
   */
  readonly unknownTags?: "allow" | "reject";
  /**
   * The dialect's node types, by `Type` (PascalCase). A table row names one
   * with `node: { type, dialect }`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: a node type is typed by its own node
  readonly nodeTypes?: Readonly<Record<string, NodeType<any>>>;
  /** Builds what a `{ call }` trigger produces. Required when the table has one. */
  readonly lowerTrigger?: (
    id: string,
    text: string,
    span: SourceSpan,
    ctx: TriggerContext & { readonly position: CallPosition },
  ) => TriggerResult;
  /** IR for a block tag (`{% … %}`): its raw text between the delimiters. */
  readonly lowerBlockTag?: (
    text: string,
    span: SourceSpan,
    ctx: SyntaxBuildContext,
  ) => IrNode | readonly IrNode[];
  /** IR for a filter block: its name and raw body. */
  readonly lowerFilter?: (
    name: string,
    body: string,
    span: SourceSpan,
    ctx: SyntaxBuildContext,
  ) => IrNode | readonly IrNode[];
  /**
   * Runs once per lowered unit, after core's own checks (every `transform`
   * done, before `finalize`), with a read-only view of the unit: its custom
   * tag calls, what `analyze` hooks declared, and `fail` / `warn`.
   * @unstable
   */
  readonly afterLower?: (unit: LoweredUnit) => void;
  /**
   * Contract keys this dialect owns: accepted at registration as opaque data
   * (a key core does not know is otherwise an error), handed to `afterLower`
   * on `ContractCall.contract`, and never checked by core. A key core
   * checks itself (`type`, `children`, ...) cannot be claimed. @unstable
   */
  readonly contractFields?: ContractFields;
  /**
   * Checks, at registration, a contract that uses a key the dialect claims
   * (`contractFields`), at any depth: `customTags`, `mx.contracts` modules
   * and sidecars alike, called tag or not. `ctx.fail` raises the error where
   * core's own registration error lands (the sidecar's file, the contracts
   * module at 1:0, no position for the `customTags` option). @unstable
   */
  readonly checkContract?: (
    tag: string,
    contract: ContractData,
    ctx: ContractCheckContext,
  ) => void;
  /**
   * Explains a tag the file's author wrote that has no contract: called once
   * per such tag, in document order, in every `unknownTags` mode. Return an
   * explanation to report it as this dialect's error, in place of every
   * error core would give that tag (`MX_UNKNOWN_TAG`, and inside a closed
   * parent `MX_TAG_NOT_ALLOWED`); return `undefined` for core's own
   * behaviour. It cannot make the tag known, and an explanation is always an
   * error, so the result has no IR. Synchronous. A hook that throws, or
   * returns a malformed value, is reported as `MX_DIALECT_HOOK_ERROR` at the
   * tag. @unstable
   */
  readonly explainUnknownTag?: (
    tag: UnknownTag,
  ) => UnknownTagExplanation | undefined;
  /**
   * Words what an attribute declaration that uses a key the dialect claims
   * accepts, for core's whole-value shape error (`` attribute `mode` must be
   * atom, got string ``): the text appended to it, such as
   * `" (one of :a, :b)"`, or `""`. Core never reads a claimed key itself;
   * without this hook its message names only what it knows. @unstable
   */
  readonly describeAttribute?: (
    declaration: Readonly<Record<string, unknown>>,
  ) => string;
  /**
   * The words core's messages use on this dialect's files: what an
   * attribute, the data file and its tree are called, and how a tag is
   * spelled. Absent members keep MX's words. See {@link MessageVocabulary}.
   * @unstable
   */
  readonly messageVocabulary?: MessageVocabulary;
  /**
   * Turns one of this dialect's tag files (a file in one of its manifest's
   * `tagDirs`) into a contract. Sync. The scan never runs it: the first call
   * of the tag does, and core caches the result per tag file (its stamp,
   * this module's revision, the tag file's own scan and every dependency).
   * The contract is checked as any registered tag's, and the call gets what
   * a contract-only `.tag.ts` call gets: a `DelegatedTag`, plus `definedIn`.
   * Without this hook, a call of such a tag is an `MX_TAG_FILE_ERROR`.
   * @unstable
   */
  readonly tagFile?: (file: TagFileInput, ctx: TagFileContext) => TagFileResult;
  /**
   * The dialect's tag vocabulary: a contract per tag name, as `customTags`
   * would register it (every `CustomTag` key but `template`, plus the keys
   * the dialect claims in `contractFields.tag`). Every file routed to the
   * dialect, and every entry given the dialect as `dialect`, registers them
   * in every tool. A name the manifest lists in `reservedTags` is the
   * dialect's alone: a project definition of it is `MX_RESERVED_TAG`. Any
   * other name is a default the project may replace (a tag file, `mx.tags`,
   * `mx.contracts` or `customTags`), silently. With an explicit `dialect`,
   * the caller's `customTags` are the dialect's own and replace any of them.
   * Validated once per module revision, when the dialect loads: a contract
   * that cannot register fails the dialect (`MX_INVALID_DIALECT_CONTRACT`,
   * at the entry's key in the module). A core reserved name (`if`, `try`,
   * ...) cannot be defined. @unstable
   */
  readonly contracts?: ContractMap;
  /**
   * Whether a PascalCase tag bound in the file (an `import`, a `<const>`,
   * a `<define>`, a loop or define parameter) is a component call. Default
   * `true`: the binding wins over a contract, a wildcard `children["*"]`
   * entry and every registered tag of that name. Set `false` for a dialect
   * whose files are data, where a named import is only a value the file
   * uses: no binding then makes a tag a call, so the tag reads as if
   * unbound (the wildcard claims it, its contract applies, the unknown-tag
   * rules judge it) and the import stays in the file's imports. Use it when
   * an import's name can also be a tag name; without it the tag is a
   * dynamic tag, which a data file refuses. @unstable
   */
  readonly bindingsCallTags?: boolean;
  /**
   * Renames the codes core reports on this dialect's files: each key is a
   * core code (`MX_UNKNOWN_TAG`, `MX_DUPLICATE_ATTRIBUTE`, ...), each value
   * the code the dialect's files report instead. An explicit map, never a
   * prefix: a code it does not name keeps its MX code.
   *
   * Applied once to the final diagnostics of `lowerSource` and of the
   * language tools built on it (the editors, `mx-tsc`), after they are
   * ordered, so message, position, range, severity and fixes are unchanged.
   * A code the dialect itself raises (`ctx.fail`'s `code`, `explainUnknownTag`'s
   * `code`) is never renamed. `MX_INTERNAL_ERROR` and `MX_DIALECT_HOOK_ERROR`
   * stay MX's and cannot be keys; `MX_DIALECT_ERROR` and `MX_DIALECT_WARNING` load
   * but are ignored: a code that reports the dialect itself stays MX's. A
   * value is a non-empty string that does not
   * start with `MX_`; two keys may share one value. A bad map fails the dialect
   * at load. @unstable
   */
  readonly diagnosticCodes?: Partial<Record<MxDiagnosticCode, string>>;
}

/**
 * A dialect module's default export: a {@link Dialect} whose `id` and `name`
 * may be left to its manifest, which stamps them when it loads (if the
 * module states them, they must match). @unstable
 */
export type DialectModule = Omit<Dialect, "id" | "name"> & {
  readonly id?: string;
  readonly name?: string;
};

/** A file's syntax: its table and, when a dialect supplied it, the dialect. */
export interface ResolvedSyntax {
  readonly table: SyntaxTable;
  readonly dialect?: Dialect;
  /** The `.mx` default row with no dialect: nothing to lower. */
  readonly isDefault?: true;
}

/** One problem `validateSyntaxTable` reports. */
export interface SyntaxDiagnostic {
  readonly field: string;
  readonly triggerId?: string;
  readonly message: string;
}

/** The fields a dialect's `table` may set: the table's, less `tagTypes`. */
const MANIFEST_FIELDS = new Set([
  "placeholder",
  "inlineScript",
  "blockTag",
  "filter",
  "concise",
  "tagShorthands",
  "expressionTriggers",
  "attributeTriggers",
  "lineTriggers",
  "valueTriggers",
  "textTriggers",
  "expressionLanguage",
]);

/** Canonical JSON (keys sorted at every level), the input of a table's hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hashes already computed, per deep-frozen table object. */
const hashes = new WeakMap<object, string>();

/** For tests: how many tables have been hashed (cache misses) in this process. */
export const syntaxHashes = { count: 0 };

/** A table's identity: the sha256 of its canonical JSON. Two tables with the same content hash alike. */
export function syntaxHash(table: SyntaxTable): string {
  let hash = hashes.get(table);
  if (hash === undefined) {
    syntaxHashes.count++;
    hash = createHash("sha256").update(canonical(table)).digest("hex");
    if (isDeepFrozen(table)) hashes.set(table, hash);
  }
  return hash;
}

/**
 * The `.mx` default row, core's own copy of the parser's `DEFAULT_SYNTAX`
 * (a test pins them equal), so the default path never needs the parser: a
 * stock `htmljs-parser` swapped into the bundle has no syntax table.
 */
const DEFAULT_ROW: SyntaxTable = deepFreeze({
  placeholder: { open: "${", close: "}" },
  inlineScript: { trigger: "$ " },
  blockTag: null,
  filter: null,
  concise: true,
  tagShorthands: true,
  expressionTriggers: [],
  attributeTriggers: [],
  lineTriggers: [],
  textTriggers: [],
  tagTypes: {},
  expressionLanguage: "ts",
});

/**
 * The `.mx` default row, deeply frozen: the base a consumer overlays to
 * build its own table (Mesh's `&` row), and what MX's own files parse
 * with.
 */
export function defaultSyntax(): SyntaxTable {
  return DEFAULT_ROW;
}

let defaultHash: string | undefined;

/** The hash of the default row. */
export function defaultSyntaxHash(): string {
  defaultHash ??= syntaxHash(DEFAULT_ROW);
  return defaultHash;
}

/** MX's template parser when it carries the syntax table API; undefined for a stock parser. */
function syntaxParser() {
  const parser = mxTemplateParser();
  return typeof parser.validateSyntaxTable === "function" ? parser : undefined;
}

/** Why a table cannot be honoured: the installed parser has no syntax table. */
const NEEDS_MX_PARSER =
  "needs a template parser with the syntax-table API; the installed `htmljs-parser` has none";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const field of Object.values(value)) deepFreeze(field);
    Object.freeze(value);
  }
  return value;
}

/** Resolved tables by hash: one frozen object per distinct table in the process. */
const byHash = new Map<string, SyntaxTable>();

function intern(table: SyntaxTable): SyntaxTable {
  const hash = syntaxHash(table);
  const known = byHash.get(hash);
  if (known) return known;
  const frozen = deepFreeze(table);
  byHash.set(hash, frozen);
  return frozen;
}

/** The default row as a resolved syntax: no dialect. */
const DEFAULT_RESOLVED: ResolvedSyntax = Object.freeze({
  table: DEFAULT_ROW,
  isDefault: true,
});

/** The hooks and fields a dialect may export. */
const MODULE_FIELDS = new Set([
  "id",
  "name",
  "table",
  "tagRules",
  "structural",
  "imports",
  "unknownTags",
  "nodeTypes",
  "lowerTrigger",
  "lowerBlockTag",
  "lowerFilter",
  "afterLower",
  "contractFields",
  "checkContract",
  "explainUnknownTag",
  "describeAttribute",
  "messageVocabulary",
  "tagFile",
  "contracts",
  "bindingsCallTags",
  "diagnosticCodes",
]);

/** The lowering options a dialect states a default for, with the values each accepts. */
const LOWER_OPTION_VALUES = [
  ["structural", ["pass", "reject"]],
  ["imports", ["pass", "reject"]],
  ["unknownTags", ["allow", "reject"]],
] as const;

const MODULE_HOOKS = [
  "lowerTrigger",
  "lowerBlockTag",
  "lowerFilter",
  "afterLower",
  "checkContract",
  "explainUnknownTag",
  "describeAttribute",
  "tagFile",
] as const;

/** Each problem as `` `<path>.<field>` (trigger "<id>"): <message> ``, joined. */
function describeProblems(
  problems: readonly SyntaxDiagnostic[],
  path: string,
): string {
  return problems
    .map(
      (problem) =>
        `\`${path}.${problem.field}\`${problem.triggerId === undefined ? "" : ` (trigger "${problem.triggerId}")`}: ${problem.message}`,
    )
    .join("; ");
}

/**
 * A dialect's `table` overlaid on the default row, validated, frozen and
 * interned by hash. `path` names the fields in every message (`table`,
 * `dialect.table`).
 */
function overlayTable(
  value: unknown,
  path: string,
  fail: (message: string) => never,
): SyntaxTable {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`\`${path}\` must be an object overlaying the syntax table`);
  }
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (key === "tagTypes") {
      fail(
        `\`${path}.tagTypes\` is not a manifest field: tag types are taglib-owned, computed from the tags and their parseOptions`,
      );
    }
    if (!MANIFEST_FIELDS.has(key)) {
      fail(
        `\`${path}.${key}\` is not a syntax table field (${[...MANIFEST_FIELDS].join(", ")})`,
      );
    }
  }
  const table = { ...DEFAULT_ROW, ...fields } as SyntaxTable;
  if (syntaxHash(table) === defaultSyntaxHash()) return DEFAULT_ROW;
  const parser = syntaxParser();
  if (!parser) fail(`\`${path}\`: ${NEEDS_MX_PARSER}`);
  const problems = (parser as MxTemplateParser).validateSyntaxTable(table);
  if (problems.length > 0) fail(describeProblems(problems, path));
  const own = coreMarkProblem(table, path);
  if (own) fail(own);
  return intern(structuredClone(table));
}

/**
 * Why a row cannot start with the text it does: the parser reads that text
 * itself (a spread, a tag's parameters) before any row is tried, so the row
 * would never fire.
 */
function coreMarkProblem(table: SyntaxTable, path: string): string | undefined {
  const clash = findCoreMarkClash(table);
  if (!clash) return undefined;
  return `\`${path}.${clash.list}[${clash.index}]\` (row \`${clash.row}\`) marks ${JSON.stringify(clash.mark)}, which core reads itself in that position as ${clash.what} (\`${clash.coreMark}\`); core's reading wins, so the row would never fire. Change \`chars\` and \`match\` of the row to start with another character`;
}

/** The first `{ call }` trigger of a table, with its field path, in list order. */
function firstCallTrigger(
  table: SyntaxTable,
): { field: string; id: string } | undefined {
  for (const list of [
    "expressionTriggers",
    "attributeTriggers",
    "lineTriggers",
    "textTriggers",
  ] as const) {
    const index = table[list].findIndex((trigger) => isCallRow(trigger.node));
    if (index >= 0) {
      return { field: `${list}[${index}]`, id: table[list][index]?.id ?? "" };
    }
  }
  return undefined;
}

/**
 * The tag rules a dialect's files parse with: the preset its module states,
 * else `html`, the full strict rules. A dialect never inherits a target's
 * preset, and project config never changes it. `lowerSource` reads it when its
 * call states no `tagRules`.
 */
export function dialectTagRules(dialect: Dialect): TagRulesPreset {
  return dialect.tagRules ?? "html";
}

/** Fails the dialect when its `diagnosticCodes` map is not a valid rename map. */
function checkDiagnosticCodes(
  map: unknown,
  path: string,
  fail: (message: string) => never,
): void {
  if (map === undefined) return;
  const field = `${path}diagnosticCodes`;
  if (
    map === null ||
    typeof map !== "object" ||
    Array.isArray(map) ||
    (Object.getPrototypeOf(map) !== Object.prototype &&
      Object.getPrototypeOf(map) !== null)
  ) {
    fail(
      `\`${field}\` must be an object mapping core diagnostic codes to the dialect's codes`,
    );
  }
  for (const [key, code] of Object.entries(map as Record<string, unknown>)) {
    if (UNRENAMEABLE_CODES.has(key)) {
      fail(
        `\`${field}.${key}\`: \`${key}\` stays MX's own code and cannot be renamed (\`MX_INTERNAL_ERROR\` and \`MX_DIALECT_HOOK_ERROR\` report a bug in MX or in a dialect hook)`,
      );
    }
    if (!isMxDiagnosticCode(key)) {
      fail(
        `\`${field}.${key}\`: \`${key}\` is not a core diagnostic code; a key names the code core reports (\`MX_UNKNOWN_TAG\`, ...)`,
      );
    }
    if (typeof code !== "string" || code.length === 0) {
      fail(
        `\`${field}.${key}\` must be a non-empty string: the dialect's code`,
      );
    }
    if (isReservedHookCode(code as string)) {
      fail(`\`${field}.${key}\`: ${reservedHookCodeMessage(code as string)}`);
    }
  }
}

/** The members `Dialect.messageVocabulary` may state. */
const VOCABULARY_FIELDS = ["attribute", "file", "tree", "formatTag"] as const;

/**
 * Fails the dialect when its `messageVocabulary` is not a valid vocabulary:
 * an object of known members, each noun a non-empty single-line string
 * without backticks (a message wraps names in backticks itself), `article`
 * `"a"` or `"an"`, `formatTag` a function.
 */
function checkMessageVocabulary(
  vocabulary: unknown,
  path: string,
  fail: (message: string) => never,
): void {
  if (vocabulary === undefined) return;
  const field = `${path}messageVocabulary`;
  if (
    vocabulary === null ||
    typeof vocabulary !== "object" ||
    Array.isArray(vocabulary)
  ) {
    fail(`\`${field}\` must be an object (${VOCABULARY_FIELDS.join(", ")})`);
  }
  const members = vocabulary as Record<string, unknown>;
  for (const key of Object.keys(members)) {
    if (!(VOCABULARY_FIELDS as readonly string[]).includes(key)) {
      fail(
        `\`${field}.${key}\` is not a message vocabulary field (${VOCABULARY_FIELDS.join(", ")})`,
      );
    }
  }
  const noun = (value: unknown, name: string): void => {
    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      /[\r\n`]/.test(value)
    ) {
      fail(
        `\`${name}\` must be a non-empty single-line string without backticks, got ${JSON.stringify(value)}`,
      );
    }
  };
  // A noun stated in both numbers: `{ one, many, article? }`. `what` names it
  // in the unknown-field error; `shape` is the error for a value that is not
  // an object.
  const numbered = (
    value: unknown,
    name: string,
    what: string,
    shape: string,
  ): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(shape);
    }
    const parts = value as Record<string, unknown>;
    for (const key of Object.keys(parts)) {
      if (key !== "one" && key !== "many" && key !== "article") {
        fail(
          `\`${name}.${key}\` is not a field of the ${what} noun (one, many, article)`,
        );
      }
    }
    noun(parts.one, `${name}.one`);
    noun(parts.many, `${name}.many`);
    if (
      parts.article !== undefined &&
      parts.article !== "a" &&
      parts.article !== "an"
    ) {
      fail(
        `\`${name}.article\` must be "a" or "an", got ${JSON.stringify(parts.article)}`,
      );
    }
  };
  if (members.attribute !== undefined) {
    numbered(
      members.attribute,
      `${field}.attribute`,
      "attribute",
      `\`${field}.attribute\` must be an object \`{ one, many, article? }\`, such as \`{ one: "option", many: "options" }\``,
    );
  }
  if (members.file !== undefined) {
    if (typeof members.file === "string") {
      noun(members.file, `${field}.file`);
    } else {
      numbered(
        members.file,
        `${field}.file`,
        "file",
        `\`${field}.file\` must be a string, or an object \`{ one, many, article? }\`, such as \`{ one: "index file", many: "index files" }\`, got ${JSON.stringify(members.file)}`,
      );
    }
  }
  if (members.tree !== undefined) noun(members.tree, `${field}.tree`);
  if (
    members.formatTag !== undefined &&
    typeof members.formatTag !== "function"
  ) {
    fail(`\`${field}.formatTag\` must be a function`);
  }
}

/**
 * A dialect's shape: an object with an `id` and a `name`, a `table`
 * object, a `tagRules` preset, node types, hooks that are functions. `path`
 * prefixes the field names (the option's wording, or the module's default
 * export). `identity` is the manifest's `id` and `name` for a loaded
 * module: stamped on the dialect, and a module that states either must
 * agree with it. `failContract` places a `contracts` entry's error (at its
 * key in the module, or as the option's error).
 */
function checkModuleShape(
  value: Record<string, unknown>,
  path: string,
  fail: (message: string) => never,
  failContract: ContractFail,
  identity?: { readonly id: string; readonly name: string },
): Dialect {
  if (identity) {
    for (const key of ["id", "name"] as const) {
      if (value[key] !== undefined && value[key] !== identity[key]) {
        fail(
          `\`${path}${key}\` is ${JSON.stringify(value[key])}, and the dialect's \`package.json#mx.dialect.${key}\` is ${JSON.stringify(identity[key])}: leave it to the manifest, or make them agree`,
        );
      }
    }
    value = { ...value, id: identity.id, name: identity.name };
  }
  for (const key of Object.keys(value)) {
    if (!MODULE_FIELDS.has(key)) {
      fail(
        `\`${path}${key}\` is not a dialect field (${[...MODULE_FIELDS].join(", ")})`,
      );
    }
  }
  if (value.table === undefined) {
    fail(`\`${path}table\` is required: the dialect's syntax table fields`);
  }
  if (
    value.tagRules !== undefined &&
    !(TAG_RULES_PRESETS as readonly unknown[]).includes(value.tagRules)
  ) {
    fail(
      `\`${path}tagRules\` must be one of core's tag rule presets: ${TAG_RULES_PRESETS.map((name) => `"${name}"`).join(", ")}`,
    );
  }
  for (const [key, allowed] of LOWER_OPTION_VALUES) {
    if (
      value[key] !== undefined &&
      !(allowed as readonly unknown[]).includes(value[key])
    ) {
      fail(
        `\`${path}${key}\` must be ${allowed.map((name) => `"${name}"`).join(" or ")}`,
      );
    }
  }
  checkDialectNodeTypes(value, path, fail);
  for (const hook of MODULE_HOOKS) {
    if (value[hook] !== undefined && typeof value[hook] !== "function") {
      fail(`\`${path}${hook}\` must be a function`);
    }
  }
  if (
    value.bindingsCallTags !== undefined &&
    typeof value.bindingsCallTags !== "boolean"
  ) {
    fail(`\`${path}bindingsCallTags\` must be a boolean`);
  }
  checkDiagnosticCodes(value.diagnosticCodes, path, fail);
  checkMessageVocabulary(value.messageVocabulary, path, fail);
  checkContractFields(value.contractFields, path, fail);
  checkDialectContracts(value, path, failContract);
  // SAFETY: the checks above validated `value` field by field (keys in
  // MODULE_FIELDS, `id` and `name` stamped or checked, `table` present,
  // hooks functions, contract fields and contracts checked) — exactly Dialect's shape;
  // the assertion carries that dynamic validation into the typed interface.
  return (identity ? Object.freeze(value) : value) as unknown as Dialect;
}

/** Is this `dialect` option value a dialect rather than a bare table? */
function isDialect(value: unknown): value is Dialect {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "table" in value
  );
}

/**
 * Loads the dialect `manifest` declares: its `module`, resolved from its
 * package directory, with the manifest's `id` and `name` stamped on it. A
 * module that does not resolve is an error at the manifest's `module`; a
 * module that fails to load or has the wrong shape, a `{ call }` row with
 * no `lowerTrigger`, or a row naming a node type the dialect does not
 * register is an error in the module file at 1:0.
 */
function loadDialect(
  manifest: DialectManifest,
  loading?: (file: string) => void,
): {
  resolved: ResolvedSyntax;
  file: string;
} {
  const packageDir = dirname(manifest.packageFile);
  const failAtModule = (message: string): never => {
    const read = readPackageJsonText(manifest.packageFile);
    const { line, column } = jsonKeyPosition(read, ["mx", "dialect", "module"]);
    throw codedError(
      MODULE_LOAD_FAILED_CODE,
      message,
      line,
      column,
      manifest.packageFile,
    );
  };
  let file = "";
  const require = createRequire(manifest.packageFile);
  try {
    file = require.resolve(resolve(packageDir, manifest.module));
  } catch {
    failAtModule(
      isPackageSpecifier(manifest.module, require)
        ? `the dialect \`${manifest.id}\`'s module "${manifest.module}" cannot be resolved from ${packageDir}: \`mx.dialect.module\` is a file path inside the dialect's package ("./dist/dialect.js"), not a package specifier`
        : `the dialect \`${manifest.id}\`'s module "${manifest.module}" cannot be resolved from ${packageDir}. Check \`mx.dialect.module\`.`,
    );
  }
  // Bun and Vitest load TypeScript, Node does not: an installed dialect that
  // ships its source would work here and fail for every Node user.
  if (TYPESCRIPT_MODULE.test(file) && isInstalled(packageDir)) {
    failAtModule(
      `the dialect \`${manifest.id}\`'s module "${manifest.module}" is TypeScript: an installed dialect's module must be JavaScript Node can load. Build it to \`.js\`, \`.mjs\` or \`.cjs\` and point \`mx.dialect.module\` at the build`,
    );
  }
  const failInModule = (message: string): never => {
    throw codedError(INVALID_DIALECT_MODULE_CODE, message, 1, 0, file);
  };
  // A contract's error is at its key when the module writes it as a literal.
  const failContract: ContractFail = (message, at, code) => {
    const key = staticKeyPathPosition(file, at);
    const error = codedError(
      INVALID_DIALECT_CONTRACT_CODE,
      message,
      key?.line ?? 1,
      key?.column ?? 0,
      file,
    );
    if (key?.end) error.end = key.end;
    error.diagnosticCode = code;
    throw error;
  };
  loading?.(file);
  const dialect = checkModuleShape(
    loadDialectModule(file),
    "",
    failInModule,
    failContract,
    manifest,
  );
  const table = overlayTable(dialect.table, "table", failInModule);
  const call = firstCallTrigger(table);
  if (call && !dialect.lowerTrigger) {
    failInModule(
      `\`table.${call.field}\` (trigger "${call.id}") has a \`{ call }\` node, and the dialect exports no \`lowerTrigger\``,
    );
  }
  const unregistered = unregisteredNodeRow(table, dialect, "table");
  if (unregistered) failInModule(unregistered);
  return { resolved: { table, dialect }, file };
}

const TYPESCRIPT_MODULE = /\.(?:ts|mts|cts|tsx)$/;

/**
 * Is `module` a package specifier (`@scope/pkg/dialect`, or a bare name Node
 * resolves from the package) rather than a path inside the package?
 */
function isPackageSpecifier(module: string, require: NodeRequire): boolean {
  if (/^\.{1,2}(?:[\\/]|$)/.test(module) || isAbsolute(module)) return false;
  if (module.startsWith("@")) return true;
  try {
    require.resolve(module);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the package at `dir` installed (its real path inside a `node_modules`),
 * not a workspace package linked into one?
 */
function isInstalled(dir: string): boolean {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // An unreadable path is judged as written.
  }
  return real.split(sep).includes("node_modules");
}

function readPackageJsonText(file: string): string {
  return readPackageJsonCached(file)?.text ?? "";
}

/**
 * The removed `mx.syntax`, in any MX config file (no setting selects a file's
 * syntax): an error at its key.
 */
function rejectRemovedSyntax(source: MxConfigSource | undefined): void {
  const config = source?.config;
  if (!source || !config || config.syntax === undefined) return;
  const packageFile = source.file;
  const { line, column } = mxKeyPosition(packageFile, "syntax");
  throw codedError(
    INVALID_CONFIG_CODE,
    "`mx.syntax` is removed: a syntax of your own is a dialect, a package that declares itself in its `package.json#mx.dialect` (`id`, `name`, the `extensions` it claims, its `module`) and is one of the project's dependencies; a file goes to the dialect that claims its extension. `.mx` files are always MX's.",
    line,
    column,
    packageFile,
  );
}

/**
 * Each loaded dialect, per manifest, so an unchanged module is never
 * re-validated: the dialect, or why its module failed to load or validate,
 * kept until the module file changes.
 */
const byDialect = new WeakMap<
  DialectManifest,
  | { resolved: ResolvedSyntax; file: string; mtimeMs?: number }
  | { error: TranslateError; file: string; mtimeMs?: number }
>();

/** Each loaded dialect's module file, and the manifest that declared it. */
const loadedDialects = new WeakMap<
  Dialect,
  { file: string; manifest: DialectManifest }
>();

function mtimeOf(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Each dialect module file's last load, per revision (its mtime). */
const moduleLoads = new Map<
  string,
  | { mtimeMs?: number; failed: false; definition: Record<string, unknown> }
  | { mtimeMs?: number; failed: true; error: unknown }
>();

/**
 * A dialect module's default export, loaded once per revision of its file.
 * A failed load is kept and rethrown until the file changes: before 22.20,
 * Node cannot `require` an ES module again once its evaluation threw (the
 * second `require` fails with "Unexpected module status"), so loading it
 * again would replace the dialect's own error with Node's.
 */
function loadDialectModule(file: string): Record<string, unknown> {
  const mtimeMs = mtimeOf(file);
  const known = moduleLoads.get(file);
  if (known && known.mtimeMs === mtimeMs) {
    if (known.failed) throw known.error;
    return known.definition;
  }
  try {
    const definition = loadDefaultExport(file, "dialect");
    moduleLoads.set(file, { mtimeMs, failed: false, definition });
    return definition;
  } catch (error) {
    moduleLoads.set(file, { mtimeMs, failed: true, error });
    throw error;
  }
}

/**
 * The syntax for `filename`: the dialect that claims its extension among
 * its project's (the nearest `package.json`'s) direct dependencies, so a
 * dependency's files use the dependency's dialects; MX's default row for
 * every other file. A relative or virtual name gets the default row. A
 * dialect is loaded again when its module file changes: Bun re-evaluates
 * it, and so does Node for a CommonJS module, but Node keeps an ES module it
 * has loaded (deleting its `require.cache` entry does not evict it), so an
 * edited `.mjs`/`.ts` dialect is picked up after a restart there.
 */
export function resolveSyntaxOf(
  filename: string,
  options: RouteDialectOptions = {},
): ResolvedSyntax {
  return resolveManifestSyntax(filename, options);
}

/**
 * The renames the dialect of `filename` states in `diagnosticCodes` (core code
 * to the dialect's code), or `undefined` when the file's dialect states none,
 * the file has no dialect, or the dialect does not load (the diagnostics say
 * why). The map is the one `lowerSource` applies: `MX_DIALECT_ERROR` and
 * `MX_DIALECT_WARNING` are not in it: a code that reports the dialect itself
 * stays MX's, whatever the dialect says.
 *
 * A tool that reports diagnostics it did not get from `lowerSource` (the
 * project scan's: tag files, `mx.tags`, `mx.contracts`) renames their codes
 * with it, so one core code has one name per dialect. Rename a diagnostic once:
 * `lowerSource`'s own diagnostics are already renamed. `options` are the
 * routing options the tool routes with. @unstable
 */
export function diagnosticCodesOf(
  filename: string,
  options: RouteDialectOptions = {},
): Readonly<Record<string, string>> | undefined {
  try {
    const map = resolveSyntaxOf(filename, options).dialect?.diagnosticCodes;
    return map === undefined ? undefined : effectiveDiagnosticCodes(map);
  } catch {
    return undefined;
  }
}

/**
 * The tag rules a file's dialect states for it ({@link dialectTagRules}), or
 * `undefined` for MX's own files, which parse under their target's tag
 * rules. A routed dialect and an explicit `dialect` option both count; a bare
 * table (no module) does not.
 */
export function fileTagRules(
  resolved: ResolvedSyntax,
): TagRulesPreset | undefined {
  const { dialect } = resolved;
  return dialect ? dialectTagRules(dialect) : undefined;
}

/**
 * Loads the dialect `filename` routes to, then checks its marks against the
 * other dialects its project installs (the project's own declaration and its
 * direct dependencies that declare one, `discoverDialects`): two of them
 * sharing a marking character or prefix is an error in the module of the
 * dialect being loaded, naming both. Not cached, so editing either module
 * clears it. A peer whose module does not load is skipped here; its own
 * files report why.
 */
function resolveManifestSyntax(
  filename: string,
  options: RouteDialectOptions,
): ResolvedSyntax {
  const resolved = resolveRoutedSyntax(filename, options);
  const dialect = resolved.dialect;
  const loaded = dialect && loadedDialects.get(dialect);
  if (!dialect || !loaded) return resolved;
  const found = findNearestPackageJson(dirname(filename));
  if (!found) return resolved;
  const peers = discoverDialects(found.file).filter(
    (each) => each !== loaded.manifest && each.id !== loaded.manifest.id,
  );
  for (const peer of peers) {
    const other = peerDialect(peer);
    const clash = other && findMarkOverlap(dialect.table, other.table);
    if (!clash || !other) continue;
    throw codedError(
      INVALID_DIALECT_MODULE_CODE,
      markClashMessage(
        { id: loaded.manifest.id, name: dialect.name, row: clash.first },
        { id: peer.id, name: other.name, row: clash.second },
        clash.mark,
      ),
      1,
      0,
      loaded.file,
    );
  }
  return resolved;
}

/** The message for two installed dialects whose marks clash, shared by the routed and the `dialect` option paths. */
function markClashMessage(
  first: { id: string; name: string; row: MarkOverlap["first"] },
  second: { id: string; name: string; row: MarkOverlap["second"] },
  mark: string,
  option?: { bare: boolean },
): string {
  const named = (id: string, name: string) =>
    id === name ? `\`${id}\`` : `\`${id}\` (${name})`;
  const rows = (who: string, row: MarkOverlap["first"]) =>
    `the \`${row.row}\` row of ${who} (\`table.${row.list}\`)`;
  if (option) {
    const label = option.bare
      ? "the `dialect` option's table"
      : `the \`dialect\` option ${named(first.id, first.name)}`;
    return `${label} and the installed dialect ${named(second.id, second.name)} both mark ${JSON.stringify(mark)}: ${rows(option.bare ? "the table" : `\`${first.id}\``, first.row)} and ${rows(`\`${second.id}\``, second.row)}. A mark belongs to one dialect: change \`chars\` and \`match\` of one of those rows to a character or prefix the other does not use, or remove the dependency on \`${second.id}\``;
  }
  return `dialects ${named(first.id, first.name)} and ${named(second.id, second.name)} are installed in one project and both mark ${JSON.stringify(mark)}: ${rows(`\`${first.id}\``, first.row)} and ${rows(`\`${second.id}\``, second.row)}. A mark belongs to one dialect: change \`chars\` and \`match\` of one of those rows to a character or prefix the other does not use, or remove one of the two dependencies`;
}

/** The dialect a peer manifest declares, loaded (and cached) on its own; `undefined` when its module fails. */
function peerDialect(manifest: DialectManifest): Dialect | undefined {
  const known = byDialect.get(manifest);
  if (known && !("error" in known) && mtimeOf(known.file) === known.mtimeMs) {
    return known.resolved.dialect;
  }
  try {
    let module: { file: string; mtimeMs?: number } | undefined;
    const { resolved, file } = loadDialect(manifest, (each) => {
      module = { file: each, mtimeMs: mtimeOf(each) };
    });
    byDialect.set(manifest, { resolved, ...(module ?? { file }) });
    if (resolved.dialect) {
      loadedDialects.set(resolved.dialect, { file, manifest });
    }
    return resolved.dialect;
  } catch {
    return undefined;
  }
}

function resolveRoutedSyntax(
  filename: string,
  options: RouteDialectOptions,
): ResolvedSyntax {
  if (!isAbsolute(filename)) return DEFAULT_RESOLVED;
  rejectRemovedSyntax(findMxConfig(dirname(filename)));
  const found = findNearestPackageJson(dirname(filename));
  if (!found?.read.manifest) return DEFAULT_RESOLVED;
  const manifest = routeDialect(filename, options);
  if (!manifest) return DEFAULT_RESOLVED;
  const known = byDialect.get(manifest);
  if (known && mtimeOf(known.file) === known.mtimeMs) {
    // The same error each time, as a module that fails to evaluate.
    if ("error" in known) throw known.error;
    return known.resolved;
  }
  // Stamped before the module is read: an edit racing the load reads as a
  // change next time.
  let module: { file: string; mtimeMs?: number } | undefined;
  try {
    const { resolved, file } = loadDialect(manifest, (file) => {
      module = { file, mtimeMs: mtimeOf(file) };
    });
    byDialect.set(manifest, { resolved, ...(module ?? { file }) });
    if (resolved.dialect) {
      loadedDialects.set(resolved.dialect, { file, manifest });
    }
    return resolved;
  } catch (error) {
    // A failure in the module (its load, shape or contracts) stays until
    // the module changes; one before it (an unresolvable `module`) is the
    // manifest's, and a manifest edit is a new manifest object.
    if (module && isTranslateError(error) && error.file === module.file) {
      byDialect.set(manifest, { error, ...module });
    }
    throw error;
  }
}

/**
 * The module file a routed dialect loaded from, with the mtime it was
 * loaded at, for the scan's evidence; `undefined` for an explicit dialect.
 * A module that failed is reported through {@link failedDialectModule}.
 */
export function dialectModuleStamp(
  dialect: Dialect,
): { path: string; mtimeMs?: number } | undefined {
  const loaded = loadedDialects.get(dialect);
  if (!loaded) return undefined;
  const known = byDialect.get(loaded.manifest);
  return { path: loaded.file, mtimeMs: known?.mtimeMs };
}

/**
 * The module a dialect's failed load was kept for (`error` is what routing
 * threw), with the mtime it failed at: the scan stamps it too, so fixing the
 * module re-scans.
 */
export function failedDialectModule(
  error: unknown,
): { path: string; mtimeMs?: number } | undefined {
  if (!isTranslateError(error) || error.file === undefined) return undefined;
  const load = moduleLoads.get(error.file);
  return load ? { path: error.file, mtimeMs: load.mtimeMs } : undefined;
}

/**
 * The `customTags` a file of `dialect` registers: the caller's
 * (or the scan's) merged with the dialect's `contracts`
 * ({@link withDialectContracts}). A routed dialect's reserved names are its
 * manifest's `reservedTags`; with an `explicit` dialect the caller's
 * `customTags` override every contract. Unchanged without contracts.
 *
 * A routed caller's `customTags` entry that names one of the dialect's
 * reserved names is refused here, `MX_RESERVED_TAG` at the file start, as
 * `lowerSource` refuses it (which drops the entry before calling this) and
 * as the scan refuses a tag file: only the dialect defines a reserved name.
 * A map this merge built (`lowerSource`'s, handed to its compile) carries
 * the dialect's own reserved contracts and is not refused.
 */
export function dialectCustomTags(
  customTags: Readonly<Record<string, CustomTag>> | undefined,
  dialect: Dialect | undefined,
  explicit: boolean,
): Record<string, CustomTag> | undefined {
  if (!dialect) return customTags as Record<string, CustomTag>;
  const reserved = loadedDialects.get(dialect)?.manifest.reservedTags ?? [];
  if (!explicit && customTags && !isMergedContracts(customTags)) {
    for (const name of Object.keys(customTags)) {
      if (!reserved.includes(name)) continue;
      const error = codedError(
        RESERVED_TAG_CODE,
        dialectReservedMessage(name, "`customTags`", dialect.name),
        1,
        0,
      );
      throw error;
    }
  }
  if (!dialect.contracts) return customTags as Record<string, CustomTag>;
  return withDialectContracts(customTags, dialect, reserved, explicit);
}

// The discovery scan reads the claimed contract keys of a file's dialect
// through this, without importing the syntax table itself.
registerSyntaxResolver(
  (filePath) => resolveSyntaxOf(filePath).dialect,
  (dialect, failure) =>
    dialect ? dialectModuleStamp(dialect) : failedDialectModule(failure),
);

/**
 * The syntax table for `filename` (see {@link resolveSyntaxOf}, which also
 * returns the dialect when one supplied it).
 */
export function resolveSyntax(filename: string): SyntaxTable {
  return resolveSyntaxOf(filename).table;
}

/** Explicit tables already validated (deep-frozen tables, checked once per object). */
const validExplicit = new WeakSet<object>();

/** Explicit dialects already resolved, per deep-frozen dialect object. */
const explicitModules = new WeakMap<object, ResolvedSyntax>();

/**
 * An explicit `dialect` option (`HostOptions.dialect`,
 * `FragmentBase.dialect`, `LowerSourceOptions.dialect`: a consumer's own
 * dialect, or a bare table for a dialect with no hooks), validated with the
 * manifest's rules and wording, as the caller's error: a `TranslateError` at
 * the start of `filename` naming `dialect.<field>`. A non-empty `tagTypes` is
 * refused (taglib-owned), as in a manifest. A dialect's `table` overlays the
 * default row. A `{ call }` trigger without `lowerTrigger` is accepted here:
 * lowering reports it at the trigger ("has no lowering yet"). A row naming a
 * node type the dialect does not register is refused.
 */
export function explicitSyntaxOf(
  value: SyntaxTable | Dialect,
  filename: string,
): ResolvedSyntax {
  const fail = (message: string): never => {
    throw codedError(INVALID_DIALECT_MODULE_CODE, message, 1, 0, filename);
  };
  if (!isDialect(value)) {
    const table = explicitSyntax(value, filename);
    const unregistered = unregisteredNodeRow(table, undefined, "dialect");
    if (unregistered) fail(`the \`dialect\` option: ${unregistered}`);
    if (table !== DEFAULT_ROW) {
      checkOptionMarks(value, table, filename, isDeepFrozen(value));
    }
    return table === DEFAULT_ROW ? DEFAULT_RESOLVED : { table };
  }
  const known = explicitModules.get(value);
  if (known) {
    checkOptionMarks(value, known.table, filename, true);
    return known;
  }
  // A dialect that is not deep-frozen can change between calls: what core
  // remembers about it (the claimed contract fields, the node type registry,
  // the contract entries checked under that claim) is dropped, so this call
  // reads and checks all of it afresh.
  const cacheable = isDeepFrozen(value);
  if (!cacheable) {
    forgetClaimedFields(value);
    forgetNodeTypeRegistry(value);
  }
  const invalid = (message: string): never =>
    fail(`the \`dialect\` option is not a valid dialect: ${message}`);
  // SAFETY: `isDialect` narrowed `value` to a plain object with a `table`;
  // checkModuleShape reads its fields dynamically, so the record view is
  // the same object widened for the field-by-field validation.
  const dialect = checkModuleShape(
    value as unknown as Record<string, unknown>,
    "dialect.",
    invalid,
    (message, _at, code) => {
      try {
        return invalid(message);
      } catch (error) {
        (error as TranslateError).diagnosticCode = code;
        throw error;
      }
    },
  );
  const table = overlayTable(dialect.table, "dialect.table", invalid);
  const unregistered = unregisteredNodeRow(table, dialect, "dialect.table");
  if (unregistered) invalid(unregistered);
  const resolved: ResolvedSyntax = { table, dialect };
  checkOptionMarks(value, table, filename, cacheable);
  // Only a deep-frozen dialect is remembered: a nested object left unfrozen
  // could change, so a partly frozen one is validated on every call.
  if (cacheable) explicitModules.set(value, resolved);
  return resolved;
}

/**
 * An explicit `dialect` option that is a bare table, validated (see
 * {@link explicitSyntaxOf}, which also takes a dialect).
 */
export function explicitSyntax(
  table: SyntaxTable,
  filename: string,
): SyntaxTable {
  if (table === DEFAULT_ROW || validExplicit.has(table)) return table;
  // `null` is not "omitted" (that is `undefined`, which resolves the
  // manifest): it is refused like any other value that is not a table.
  const fail = (message: string): never => {
    throw codedError(INVALID_DIALECT_MODULE_CODE, message, 1, 0, filename);
  };
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    fail(
      `the \`dialect\` option must be a dialect or a syntax table object, not ${table === null ? "null" : Array.isArray(table) ? "an array" : typeof table}; omit it to use the dialect that claims the file's extension`,
    );
  }
  if (
    table.tagTypes &&
    typeof table.tagTypes === "object" &&
    Object.keys(table.tagTypes).length > 0
  ) {
    fail(
      "the `dialect` option's `tagTypes` must be empty: tag types are taglib-owned, computed from the tags and their parseOptions",
    );
  }
  if (syntaxHash(table) !== defaultSyntaxHash()) {
    const parser = syntaxParser();
    if (!parser) fail(`the \`dialect\` option: ${NEEDS_MX_PARSER}`);
    const problems = (parser as MxTemplateParser).validateSyntaxTable(table);
    if (problems.length > 0) {
      fail(
        `the \`dialect\` option is not a valid syntax table: ${describeProblems(problems, "dialect")}`,
      );
    }
    const own = coreMarkProblem(table, "dialect");
    if (own) {
      fail(`the \`dialect\` option is not a valid syntax table: ${own}`);
    }
  }
  // Only a deep-frozen table is remembered: one with any unfrozen nested
  // object or array could change, so it is validated on every call.
  if (isDeepFrozen(table)) validExplicit.add(table);
  return table;
}

const TRIGGER_LISTS = [
  "expressionTriggers",
  "attributeTriggers",
  "lineTriggers",
  "valueTriggers",
  "textTriggers",
] as const;

/**
 * The explicit `dialect` options already compared with their project's
 * installed dialects: per option object (a table or a dialect, deep-frozen
 * only), the `package.json` it was compared in and the peers it passed
 * against, each with its module's mtime. A call finds the same peers
 * unchanged and skips the comparison; a changed peer, a different project
 * or an unfrozen option is compared again.
 */
const comparedOptions = new WeakMap<
  object,
  Map<string, readonly { manifest: DialectManifest; mtimeMs?: number }[]>
>();

/**
 * Checks an explicit `dialect` option the way the routed path checks a
 * dialect: its marks against the other dialects its file's project installs
 * (`discoverDialects` of the nearest `package.json`). The passed dialect is
 * the project's own when it shares an installed dialect's id (a bare table
 * when it equals an installed table), and is not compared with itself. A
 * relative or virtual `filename`, or a file with no `package.json`, names no
 * project: nothing is installed to compare with. The clash is an error at the
 * start of `filename` (the option has no module), in the routed path's words.
 * Core's own marks are checked with the option's validation (`explicitSyntax`
 * and `overlayTable`: `validateSyntaxTable` and `findCoreMarkClash`), which
 * the routed path shares.
 */
function checkOptionMarks(
  option: SyntaxTable | Dialect,
  table: Partial<SyntaxTable>,
  filename: string,
  cacheable: boolean,
): void {
  // A relative name would find whatever project the working directory is in.
  if (!isAbsolute(filename)) return;
  const found = findNearestPackageJson(dirname(filename));
  if (!found) return;
  const manifests = discoverDialects(found.file);
  const peers = manifests.flatMap((manifest) => {
    const dialect = peerDialect(manifest);
    return dialect
      ? [{ manifest, dialect, mtimeMs: mtimeOfPeer(manifest) }]
      : [];
  });
  const stamp = peers.map(({ manifest, mtimeMs }) => ({ manifest, mtimeMs }));
  const known = comparedOptions.get(option)?.get(found.file);
  if (
    known &&
    known.length === stamp.length &&
    known.every(
      (each, i) =>
        each.manifest === stamp[i]?.manifest &&
        each.mtimeMs === stamp[i]?.mtimeMs,
    )
  ) {
    return;
  }
  const own = isDialect(option) ? option : undefined;
  const id = own?.id ?? "table";
  const name = own?.name ?? id;
  for (const { manifest, dialect } of peers) {
    if (own ? manifest.id === own.id : sameTable(dialect.table, table))
      continue;
    const clash = findMarkOverlap(table, dialect.table);
    if (!clash) continue;
    throw codedError(
      INVALID_DIALECT_MODULE_CODE,
      markClashMessage(
        { id, name, row: clash.first },
        { id: manifest.id, name: dialect.name, row: clash.second },
        clash.mark,
        { bare: own === undefined },
      ),
      1,
      0,
      filename,
    );
  }
  if (!cacheable) return;
  const byProject = comparedOptions.get(option) ?? new Map();
  byProject.set(found.file, stamp);
  comparedOptions.set(option, byProject);
}

/** Do the tables hold the same trigger rows (the fields a mark comes from)? */
const sameTable = (a: Partial<SyntaxTable>, b: Partial<SyntaxTable>): boolean =>
  TRIGGER_LISTS.every(
    (list) => canonical(a[list] ?? []) === canonical(b[list] ?? []),
  );

/** The mtime of the module a peer manifest loaded from. */
function mtimeOfPeer(manifest: DialectManifest): number | undefined {
  const known = byDialect.get(manifest);
  return known?.mtimeMs;
}

/** Where a parse runs: the file and the fragment's base, for positions. */
export interface SyntaxSite {
  filename: string;
  baseOffset?: number;
  baseLine?: number;
  baseColumn?: number;
}

/**
 * Does lowering build this `MxTrigger` (a built-in node kind, or core's
 * `mx:Trigger` — a `{ call }` row or a row naming it — with the dialect's
 * `lowerTrigger`)? A dialect type's node is never an `MxTrigger`: its own
 * `lower` builds it, which loading already checked.
 */
function lowersTrigger(
  table: SyntaxTable,
  dialect: Dialect | undefined,
  trigger: { id: string; position: TriggerPosition },
): boolean {
  const row = triggerRow(table, trigger);
  if (!row) return false;
  if (isCallRow(row.node) || isNodeTypeRow(row.node)) {
    return rowKey(row.node) === TRIGGER_KEY ? !!dialect?.lowerTrigger : true;
  }
  return true;
}

/**
 * The error a table gives a file before lowering, or `undefined`: the first
 * trigger, block tag or filter nothing lowers (a
 * `{ call }` trigger with no `lowerTrigger`, a block tag with no
 * `lowerBlockTag`, a filter with no `lowerFilter`), positioned, naming the
 * file, with `offset`, where it starts (the document's own offsets, less the
 * fragment base, as a `CompileError`'s `loc.start.index`). It is not a parse
 * error: a parse error is the default row's too, so the caller raises it
 * through `compileErrorOf` (same shape, `loc` included) and throws this one
 * only when it starts before the first error that parse reports. The
 * compile's own parse carries the table, so this reads its document (one
 * parse per compile). Lowering's seams (`payloadOf`, `lowerChildList`)
 * refuse the same nodes in the same wording for a caller that lowers a
 * document itself. The default row costs nothing: nothing is read.
 */
export function tableParseError(
  document: Node,
  table: SyntaxTable,
  site: SyntaxSite,
  dialect?: Dialect,
): { error: TranslateError; offset: number } | undefined {
  // The default row by identity first: a plain project pays one comparison.
  if (table === DEFAULT_ROW || syntaxHash(table) === defaultSyntaxHash()) {
    return undefined;
  }
  let found: { start: number; message: string } | undefined;
  const consider = (start: number, message: string) => {
    if (!found || start < found.start) found = { start, message };
  };
  const seen = new Set<unknown>();
  const visit = (value: Node): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    switch (value.type) {
      case "MxTrigger":
        if (!lowersTrigger(table, dialect, value)) {
          consider(value.start, `\`${value.id}\` trigger has no lowering yet`);
        }
        break;
      case "MxBlockTag":
        if (!dialect?.lowerBlockTag) {
          consider(value.start, "a block tag has no lowering yet");
        }
        break;
      case "MxFilter":
        if (!dialect?.lowerFilter) {
          consider(
            value.start,
            `the \`${value.name}\` filter has no lowering yet`,
          );
        }
        break;
    }
    for (const field of Object.values(value)) visit(field);
  };
  visit(document.body);
  if (!found) return undefined;
  const { line, column } = filePosition(document, found.start);
  return {
    error: codedError(
      NO_LOWERING_CODE,
      found.message,
      line,
      column,
      site.filename,
    ),
    offset: found.start - (document.base?.offset ?? 0),
  };
}
