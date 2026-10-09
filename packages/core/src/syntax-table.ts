/**
 * `package.json#mx.syntax` (decision 182, PR C): the syntax table a file is
 * parsed with, resolved from the nearest manifest beside `mx.tags`, and the
 * check that keeps a table core cannot lower yet from compiling silently.
 *
 * The table is plain data (`@mxlang/parser`'s `SyntaxTable`); the types are
 * declared here because the published `.d.ts` may not name the private
 * `@mxlang/parser` (a test in `@mxlang/parse-differential` pins the two
 * declarations equal). This is the interim until the MX front end is bundled
 * into core (parser port PR 4).
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  type ContractCheckContext,
  type ContractFields,
  checkContractFields,
  registerSyntaxResolver,
} from "./contract-fields.ts";
import type { Node } from "./core.ts";
import { TranslateError } from "./core.ts";
import type { IrBuilders } from "./custom-tags.ts";
import { findNearestPackageJson } from "./host-policy.ts";
import type { IrNode } from "./ir.ts";
import type { ContractData, LoweredUnit } from "./lowered-unit.ts";
import type { SourceSpan } from "./mapping.ts";

export type {
  ContractCheckContext,
  ContractData,
  ContractFields,
  LoweredUnit,
  SourceSpan,
};

import { type MxTemplateParser, mxTemplateParser } from "./marko-frontend.ts";
import { filePosition } from "./mx-parse.ts";
import type { PackageJsonRead } from "./package-json.ts";
import { loadDefaultExport, mxKeyPosition } from "./scan.ts";
import { triggerRow } from "./triggers.ts";

/** What the expression parser reads in place of a trigger's text, always of the same length. */
export type StandIn = "number" | "identifier" | "keep";

/**
 * What core builds from a trigger. The built-in kinds lower in core with no
 * hook: in an expression, `"string"` is a string literal of the trigger's
 * text and `"identifier"` an identifier named by it; in an attribute list,
 * `"attribute"` is an attribute named by the text after its first
 * character, the sigil (bare, or with its `=value`). Any other pairing is a positioned error. `{ call }` hands the
 * trigger to the syntax module's `lowerTrigger` (decision 182 addendum 5).
 */
export type TriggerNode =
  | "string"
  | "identifier"
  | "attribute"
  | { readonly call: string };

/** One row of a trigger list (decision 182). */
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
   * (decision 183: `tag #id=123` is refused). Absent, the trigger takes one.
   */
  readonly value?: "refuse";
}

/** The syntax table: one plain-data object per parse (decision 182; `language-extensions/core.md`). */
export interface SyntaxTable {
  readonly placeholder: {
    readonly open: string;
    readonly close: string;
  } | null;
  readonly inlineScript: { readonly trigger: string } | null;
  readonly blockTag: { readonly open: string; readonly close: string } | null;
  readonly filter: { readonly open: string; readonly close: string } | null;
  readonly concise: boolean;
  readonly expressionTriggers: readonly Trigger[];
  readonly attributeTriggers: readonly Trigger[];
  readonly lineTriggers: readonly Trigger[];
  readonly textTriggers: readonly Trigger[];
  /** Tag types by written name: html 0, text 1, void 2, statement 3 (the template parser's `TagType`). */
  readonly tagTypes: Readonly<Record<string, 0 | 1 | 2 | 3>>;
  readonly expressionLanguage: "ts";
}

/** Where a trigger sits: the table list that armed it. */
export type TriggerPosition = "expression" | "attribute" | "line";

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
 * one. It is opaque: a module places it with `ctx.attribute`, never builds
 * one. @unstable
 *
 * `async` is `true` when `async` is written before the trigger
 * (`kind async :name(p) { b }`): the method is an async function, and
 * `ctx.valueForm` is `"async-method"`. The `async` keyword is outside the
 * method's span (it starts at the method's `<` or `(`), so a placed value's
 * text never covers the trigger's own. A module that does not want async
 * methods refuses the form with `ctx.fail`; one that places it gets an
 * async `FunctionExpression`.
 */
export interface TriggerMethod {
  readonly kind: "method";
  readonly async: boolean;
}

/**
 * The value of an attribute `ctx.attribute` builds: `true` (a bare
 * attribute), a string, an expression, the trigger's own method value, or a
 * whole-value atom or member (`{ kind: "member", name }` for Mesh's
 * `&dueOn`). A value's `span` defaults to the trigger's own.
 */
export type TriggerAttributeValue =
  | true
  | string
  | TriggerExpression
  | TriggerMethod
  | {
      readonly kind: "atom" | "member";
      readonly name: string;
      readonly span?: SourceSpan;
    };

/**
 * How `ctx.attribute` places an attribute (all optional). @unstable
 *
 * - `authored`: the attribute is spelled by the trigger's text. A
 *   diagnostic names the text (`:email` for `name`), and a whole-value atom
 *   so placed also satisfies a `string` or `enum` contract slot as its name
 *   (decision 156 addendum 6). On the default value the trigger's own value
 *   sets, a contract's error says which trigger set it (`set by \`:n=…\``).
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
 * What `lowerTrigger` returns, matching `ctx.position`: an expression; an
 * attribute or shorthand, or a non-empty list of them (`:x() { … }` is a
 * `name` and the default value); a child.
 */
export type TriggerResult =
  | TriggerExpression
  | TriggerAttribute
  | TriggerShorthand
  | readonly (TriggerAttribute | TriggerShorthand)[]
  | TriggerChild;

/**
 * How an expression trigger's operand is used, for a module that refuses
 * some uses (an atom is a name, not a value to operate on): the object of a
 * member access, a callee (a tagged template's tag included), the operand
 * of a unary operator, a spread (`<div ...x/>` included), or a property
 * name (`{ x: 1 }`, `{ x }`). `null` for any other use. Core refuses a
 * property name after the hook returns, so a module may only refuse it in
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
 * What `lowerTrigger` is handed (decision 182 addendum 5): where the trigger
 * sits, its lowered `=value`, and the three constructors, the only way a
 * module builds anything. Each position takes the matching result:
 * `"expression"` an expression, `"attribute"` an attribute, `"line"` a
 * child. Core gives the result its positions from the trigger.
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
   * A positioned error in the module's own words, at the trigger or at
   * `at` (a span inside the document), carrying `code` when given.
   * @unstable
   */
  fail(message: string, options?: TriggerFailOptions): never;
}

/** What `lowerBlockTag` and `lowerFilter` get: the IR builders a custom tag's `transform` gets. */
export interface SyntaxBuildContext {
  readonly build: IrBuilders;
}

/**
 * A syntax module (decision 182 addendum 5): the default export of the
 * module `package.json#mx.syntax` names as a string, or the object a
 * consumer passes as the `syntax` option. `table` overlays the `.mx` default
 * row (the fields an inline `mx.syntax` may set); the hooks are post-parse
 * only (`language-extensions/core.md`, "Hooks").
 */
export interface SyntaxModule {
  readonly table: Partial<Omit<SyntaxTable, "tagTypes">>;
  /** Builds what a `{ call }` trigger produces. Required when the table has one. */
  readonly lowerTrigger?: (
    id: string,
    text: string,
    span: SourceSpan,
    ctx: TriggerContext,
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
   * Contract keys this module owns: accepted at registration as opaque data
   * (a key core does not know is otherwise an error), handed to `afterLower`
   * on `ContractCall.contract`, and never checked by core. Of core's own
   * keys only `values`, `pattern`, `ref` (attribute) and `declares` (tag)
   * can be claimed. @unstable
   */
  readonly contractFields?: ContractFields;
  /**
   * Checks, at registration, a contract that uses a key the module claims
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
   * Words what an attribute declaration that uses a key the module claims
   * accepts, for core's whole-value shape error (`` attribute `mode` must be
   * atom, got string ``): the text appended to it, such as
   * `" (one of :a, :b)"`, or `""`. Core never reads a claimed key itself;
   * without this hook its message names only what it knows. @unstable
   */
  readonly describeAttribute?: (
    declaration: Readonly<Record<string, unknown>>,
  ) => string;
  /** Names the language where core's diagnostics say "MX", unless the host sets one. */
  readonly productName?: string;
}

/** A file's syntax: its table and, when a module supplied it, the module. */
export interface ResolvedSyntax {
  readonly table: SyntaxTable;
  readonly module?: SyntaxModule;
  /** The `.mx` default row with no module: nothing to lower. */
  readonly isDefault?: true;
}

/** One problem `validateSyntaxTable` reports. */
export interface SyntaxDiagnostic {
  readonly field: string;
  readonly triggerId?: string;
  readonly message: string;
}

/** The fields `mx.syntax` may set: the table's, less `tagTypes`. */
const MANIFEST_FIELDS = new Set([
  "placeholder",
  "inlineScript",
  "blockTag",
  "filter",
  "concise",
  "expressionTriggers",
  "attributeTriggers",
  "lineTriggers",
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

/** Hashes already computed, per table object (tables are frozen data). */
const hashes = new WeakMap<object, string>();

/** For tests: how many tables have been hashed (cache misses) in this process. */
export const syntaxHashes = { count: 0 };

/** A table's identity: the sha256 of its canonical JSON. Two tables with the same content hash alike. */
export function syntaxHash(table: SyntaxTable): string {
  let hash = hashes.get(table);
  if (hash === undefined) {
    syntaxHashes.count++;
    hash = createHash("sha256").update(canonical(table)).digest("hex");
    if (Object.isFrozen(table)) hashes.set(table, hash);
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
  expressionTriggers: [],
  attributeTriggers: [],
  lineTriggers: [],
  textTriggers: [],
  tagTypes: {},
  expressionLanguage: "ts",
});

/**
 * The `.mx` default row, deeply frozen: the base a consumer overlays to
 * build its own table (Mesh's `&` row), and what a file without
 * `mx.syntax` parses with.
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
  "a syntax table other than the `.mx` default row needs MX's template parser; the installed `htmljs-parser` has no syntax table";

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

/** The default row as a resolved syntax: no module. */
const DEFAULT_RESOLVED: ResolvedSyntax = Object.freeze({
  table: DEFAULT_ROW,
  isDefault: true,
});

/** The hooks and fields a syntax module may export (decision 182 addendum 5). */
const MODULE_FIELDS = new Set([
  "table",
  "lowerTrigger",
  "lowerBlockTag",
  "lowerFilter",
  "afterLower",
  "contractFields",
  "checkContract",
  "describeAttribute",
  "productName",
]);

const MODULE_HOOKS = [
  "lowerTrigger",
  "lowerBlockTag",
  "lowerFilter",
  "afterLower",
  "checkContract",
  "describeAttribute",
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
 * Table fields (`mx.syntax`, or a module's `table`) overlaid on the default
 * row, validated, frozen and interned by hash. `path` names the fields in
 * every message (`mx.syntax`, `table`).
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
  return intern(structuredClone(table));
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
    const index = table[list].findIndex(
      (trigger) => typeof trigger.node === "object",
    );
    if (index >= 0) {
      return { field: `${list}[${index}]`, id: table[list][index]?.id ?? "" };
    }
  }
  return undefined;
}

/**
 * A syntax module's shape: an object with a `table` object, hooks that are
 * functions, a non-empty `productName`. `path` prefixes the field names
 * (the option's wording, or the module's default export).
 */
function checkModuleShape(
  value: Record<string, unknown>,
  path: string,
  fail: (message: string) => never,
): SyntaxModule {
  for (const key of Object.keys(value)) {
    if (!MODULE_FIELDS.has(key)) {
      fail(
        `\`${path}${key}\` is not a syntax module field (${[...MODULE_FIELDS].join(", ")})`,
      );
    }
  }
  if (value.table === undefined) {
    fail(`\`${path}table\` is required: the module's syntax table fields`);
  }
  for (const hook of MODULE_HOOKS) {
    if (value[hook] !== undefined && typeof value[hook] !== "function") {
      fail(`\`${path}${hook}\` must be a function`);
    }
  }
  if (
    value.productName !== undefined &&
    (typeof value.productName !== "string" || value.productName === "")
  ) {
    fail(`\`${path}productName\` must be a non-empty string`);
  }
  checkContractFields(value.contractFields, path, fail);
  return value as unknown as SyntaxModule;
}

/** Is this `syntax` option value a syntax module rather than a table? */
function isSyntaxModule(value: unknown): value is SyntaxModule {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "table" in value
  );
}

/**
 * Loads the syntax module `package.json#mx.syntax` names (resolved like
 * `mx.contracts`: a package name, or a path relative to the manifest). A
 * module that fails to load or has the wrong shape is an error in the module
 * file; a specifier that does not resolve, or a `{ call }` trigger with no
 * `lowerTrigger`, is an error at the `mx.syntax` key.
 */
function loadSyntaxModule(
  spec: string,
  packageFile: string,
  failKey: (message: string) => never,
): { resolved: ResolvedSyntax; file: string } {
  const packageDir = dirname(packageFile);
  let file = "";
  try {
    file = createRequire(packageFile).resolve(
      isAbsolute(spec) || spec.startsWith(".")
        ? resolve(packageDir, spec)
        : spec,
    );
  } catch {
    failKey(`\`mx.syntax\` could not resolve \`${spec}\` from ${packageDir}`);
  }
  const failInModule = (message: string): never => {
    throw new TranslateError(message, 1, 0, file);
  };
  const module = checkModuleShape(
    loadDefaultExport(file, "syntax module"),
    "",
    failInModule,
  );
  const table = overlayTable(module.table, "table", failInModule);
  const call = firstCallTrigger(table);
  if (call && !module.lowerTrigger) {
    failKey(
      `\`mx.syntax\` (${spec}): \`table.${call.field}\` (trigger "${call.id}") has a \`{ call }\` node, and the module exports no \`lowerTrigger\``,
    );
  }
  return { resolved: { table, module }, file };
}

/**
 * `package.json#mx.syntax`: an inline object (table fields only) overlaid on
 * the default row, or a string naming a syntax module. A problem is a
 * `TranslateError` in the manifest at the `mx.syntax` key, naming the field
 * (the `mx.tags` / `mx.contracts` precedent), or in the module file for the
 * module's own shape.
 */
function resolveMxSyntaxValue(
  value: unknown,
  packageFile: string,
): { resolved: ResolvedSyntax; file?: string } {
  if (value === undefined) return { resolved: DEFAULT_RESOLVED };
  const fail = (message: string): never => {
    const { line, column } = mxKeyPosition(packageFile, "syntax");
    throw new TranslateError(message, line, column, packageFile);
  };
  if (typeof value === "string") {
    return loadSyntaxModule(value, packageFile, fail);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "`mx.syntax` must be an object overlaying the syntax table, or a string naming a syntax module",
    );
  }
  const table = overlayTable(value, "mx.syntax", fail);
  const call = firstCallTrigger(table);
  if (call) {
    fail(
      `\`mx.syntax.${call.field}\` (trigger "${call.id}"): a \`{ call }\` node is lowered by a syntax module's \`lowerTrigger\`, and an inline \`mx.syntax\` is a table only; move the table into a module and name it (\`"syntax": "./syntax.ts"\`)`,
    );
  }
  return { resolved: table === DEFAULT_ROW ? DEFAULT_RESOLVED : { table } };
}

/**
 * The table `package.json#mx.syntax` gives (an inline object, or a module's
 * `table`), validated and interned. `undefined` means the default row.
 */
export function normalizeMxSyntax(
  value: unknown,
  packageFile: string,
): SyntaxTable {
  return resolveMxSyntaxValue(value, packageFile).resolved.table;
}

/** Each manifest read's syntax, so an unchanged `package.json` (and module) is never re-validated. */
const byManifest = new WeakMap<
  PackageJsonRead,
  { resolved: ResolvedSyntax; file?: string; mtimeMs?: number }
>();

function mtimeOf(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * The syntax for `filename`: its nearest `package.json`'s `mx.syntax`, so a
 * dependency's files use the dependency's manifest. A relative or virtual
 * name with no manifest above it gets the default row. A syntax module is
 * reloaded when its file changes.
 */
export function resolveSyntaxOf(filename: string): ResolvedSyntax {
  const resolved = resolveManifestSyntax(filename);
  return resolved === DEFAULT_RESOLVED
    ? fallbackForTesting(resolved)
    : resolved;
}

/**
 * Test-only: the syntax module a file with no `mx.syntax` resolves to, read
 * from a process global so a preload reaches every copy of core (source and
 * dist alike). `scripts/sugar-module.ts` sets it to run the existing atom
 * and name-sugar suites through the reference module (slice a1 of
 * `lang-ext-move-sugars-to-mesh`). Unset, nothing changes.
 */
const FALLBACK_FOR_TESTING = Symbol.for(
  "@mxlang/core:fallbackSyntaxForTesting",
);

function fallbackForTesting(resolved: ResolvedSyntax): ResolvedSyntax {
  const module = (globalThis as Record<symbol, unknown>)[FALLBACK_FOR_TESTING];
  if (!module) return resolved;
  return explicitSyntaxOf(
    module as SyntaxModule,
    "<fallback syntax for testing>",
  );
}

function resolveManifestSyntax(filename: string): ResolvedSyntax {
  if (!isAbsolute(filename)) return DEFAULT_RESOLVED;
  const found = findNearestPackageJson(dirname(filename));
  if (!found?.read.manifest) return DEFAULT_RESOLVED;
  const known = byManifest.get(found.read);
  if (
    known &&
    (known.file === undefined || mtimeOf(known.file) === known.mtimeMs)
  ) {
    return known.resolved;
  }
  const mx = (found.read.manifest as { mx?: { syntax?: unknown } }).mx;
  const { resolved, file } = resolveMxSyntaxValue(mx?.syntax, found.file);
  byManifest.set(found.read, {
    resolved,
    ...(file === undefined ? {} : { file, mtimeMs: mtimeOf(file) }),
  });
  return resolved;
}

// The discovery scan reads the claimed contract keys of a file's module
// through this, without importing the syntax table itself.
registerSyntaxResolver((filePath) => resolveSyntaxOf(filePath).module);

/**
 * The syntax table for `filename` (see {@link resolveSyntaxOf}, which also
 * returns the syntax module when one supplied it).
 */
export function resolveSyntax(filename: string): SyntaxTable {
  return resolveSyntaxOf(filename).table;
}

/** Explicit tables already validated (tables are frozen data, checked once per object). */
const validExplicit = new WeakSet<object>();

/** Explicit modules already resolved, per frozen module object. */
const explicitModules = new WeakMap<object, ResolvedSyntax>();

/**
 * An explicit `syntax` option (`HostOptions.syntax`, `FragmentBase.syntax`,
 * `ParseDataOptions.syntax`: a consumer's own table or syntax module, Mesh's
 * path), validated with the manifest's rules and wording, as the caller's
 * error: a `TranslateError` at the start of `filename` naming
 * `syntax.<field>`. A non-empty `tagTypes` is refused (taglib-owned), as in a
 * manifest. A module's `table` overlays the default row. A `{ call }`
 * trigger without `lowerTrigger` is accepted here: lowering reports it at
 * the trigger ("has no lowering yet"; decision 182 addendum 5 item 4).
 */
export function explicitSyntaxOf(
  value: SyntaxTable | SyntaxModule,
  filename: string,
): ResolvedSyntax {
  const fail = (message: string): never => {
    throw new TranslateError(message, 1, 0, filename);
  };
  if (!isSyntaxModule(value)) {
    const table = explicitSyntax(value, filename);
    return table === DEFAULT_ROW ? DEFAULT_RESOLVED : { table };
  }
  const known = explicitModules.get(value);
  if (known) return known;
  const module = checkModuleShape(
    value as unknown as Record<string, unknown>,
    "syntax.",
    (message) =>
      fail(`the \`syntax\` option is not a valid syntax module: ${message}`),
  );
  const table = overlayTable(module.table, "syntax.table", (message) =>
    fail(`the \`syntax\` option is not a valid syntax module: ${message}`),
  );
  const resolved: ResolvedSyntax = { table, module };
  if (Object.isFrozen(value)) explicitModules.set(value, resolved);
  return resolved;
}

/**
 * An explicit `syntax` table option, validated (see
 * {@link explicitSyntaxOf}, which also takes a syntax module).
 */
export function explicitSyntax(
  table: SyntaxTable,
  filename: string,
): SyntaxTable {
  if (table === DEFAULT_ROW || validExplicit.has(table)) return table;
  // `null` is not "omitted" (that is `undefined`, which resolves the
  // manifest): it is refused like any other value that is not a table.
  const fail = (message: string): never => {
    throw new TranslateError(message, 1, 0, filename);
  };
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    fail(
      `the \`syntax\` option must be a syntax table object, not ${table === null ? "null" : Array.isArray(table) ? "an array" : typeof table}; omit it to use the file's \`package.json#mx.syntax\``,
    );
  }
  if (
    table.tagTypes &&
    typeof table.tagTypes === "object" &&
    Object.keys(table.tagTypes).length > 0
  ) {
    fail(
      "the `syntax` option's `tagTypes` must be empty: tag types are taglib-owned, computed from the tags and their parseOptions",
    );
  }
  if (syntaxHash(table) !== defaultSyntaxHash()) {
    const parser = syntaxParser();
    if (!parser) fail(`the \`syntax\` option: ${NEEDS_MX_PARSER}`);
    const problems = (parser as MxTemplateParser).validateSyntaxTable(table);
    if (problems.length > 0) {
      fail(
        `the \`syntax\` option is not a valid syntax table: ${describeProblems(problems, "syntax")}`,
      );
    }
  }
  // Only a frozen table is remembered: an unfrozen one could change.
  if (Object.isFrozen(table)) validExplicit.add(table);
  return table;
}

/** Where a parse runs: the file and the fragment's base, for positions. */
export interface SyntaxSite {
  filename: string;
  baseOffset?: number;
  baseLine?: number;
  baseColumn?: number;
}

/** Does lowering build this trigger (a built-in node kind, or a `{ call }` with the module's `lowerTrigger`)? */
function lowersTrigger(
  table: SyntaxTable,
  module: SyntaxModule | undefined,
  trigger: { id: string; position: TriggerPosition },
): boolean {
  const row = triggerRow(table, trigger);
  if (!row) return false;
  return typeof row.node === "object" ? !!module?.lowerTrigger : true;
}

/**
 * The error a table gives a file before lowering (decision 182), or
 * `undefined`: its first table-caused template error, or the first trigger,
 * block tag or filter nothing lowers (a `{ call }` trigger with no
 * `lowerTrigger`, a block tag with no `lowerBlockTag`, a filter with no
 * `lowerFilter`), in order of appearance, positioned, naming the file. The
 * compile's own parse carries the table, so this reads its document (one
 * parse per compile). Lowering's seams (`payloadOf`, `lowerChildList`)
 * refuse the same nodes in the same wording for a caller that lowers a
 * document itself. The default row costs nothing: nothing is read.
 */
export function tableParseError(
  document: Node,
  table: SyntaxTable,
  site: SyntaxSite,
  module?: SyntaxModule,
): TranslateError | undefined {
  // The default row by identity first: a plain project pays one comparison.
  if (table === DEFAULT_ROW || syntaxHash(table) === defaultSyntaxHash()) {
    return undefined;
  }
  let found: { start: number; message: string } | undefined;
  const consider = (start: number, message: string) => {
    if (!found || start < found.start) found = { start, message };
  };
  for (const error of document.errors ?? []) {
    if (error.origin === "template") consider(error.start, error.message);
  }
  const seen = new Set<unknown>();
  const visit = (value: Node): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    switch (value.type) {
      case "MxTrigger":
        if (!lowersTrigger(table, module, value)) {
          consider(value.start, `\`${value.id}\` trigger has no lowering yet`);
        }
        break;
      case "MxBlockTag":
        if (!module?.lowerBlockTag) {
          consider(value.start, "a block tag has no lowering yet");
        }
        break;
      case "MxFilter":
        if (!module?.lowerFilter) {
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
  return new TranslateError(found.message, line, column, site.filename);
}
