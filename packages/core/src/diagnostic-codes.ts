/**
 * The stable diagnostic codes of MX: every error and warning `lowerSource`
 * and `checkDialectFile` report carries one, as `IrDiagnostic.code` (from
 * `TranslateError.diagnosticCode` and `MxWarning.code`). A message is prose
 * and may be reworded; a code is the contract a consumer matches on.
 *
 * One code names one rule family: the built-in tag, the contract facet, the
 * config key. Every code starts with `MX_`, which is MX's own prefix: a
 * dialect's hook that passes a code starting with `MX_` is refused
 * ({@link isReservedHookCode}). No code names a host, target or dialect.
 *
 * Core raises through `raise(code, …)` and `codedError(code, …)`
 * (`core.ts`), whose `code` is a {@link MxDiagnosticCode}: a string that is
 * none of this module's codes does not compile. The union and
 * {@link MX_DIAGNOSTIC_CODES} are kept by hand; `diagnostic-code-table.test.ts`
 * fails when a `*_CODE` constant is missing from the catalogue or a
 * catalogue code has no input that reaches it (or no reason it cannot).
 */

// --- Lowering of authored source: what the file's author wrote ---

/** An attribute name, `on:`/`on-` form, function value, argument list or second member the language rejects. */
export const INVALID_ATTRIBUTE_CODE = "MX_INVALID_ATTRIBUTE";
/** `:=` on something that is not an identifier or member expression. */
export const INVALID_BOUND_ATTRIBUTE_CODE = "MX_INVALID_BOUND_ATTRIBUTE";
/** A second value attribute on a tag that takes one. */
export const DUPLICATE_VALUE_ATTRIBUTE_CODE = "MX_DUPLICATE_VALUE_ATTRIBUTE";
/** Tag arguments the tag does not take: beside attributes or a body, several or a spread on a named custom tag, any on an attribute tag. */
export const UNSUPPORTED_TAG_ARGUMENTS_CODE = "MX_UNSUPPORTED_TAG_ARGUMENTS";
/** An expression lowering cannot read. */
export const INVALID_EXPRESSION_CODE = "MX_INVALID_EXPRESSION";
/** The shape rules of `<if>`, `<else-if>` and `<else>`. */
export const INVALID_IF_CODE = "MX_INVALID_IF";
/** The shape rules of `<for>`. */
export const INVALID_FOR_CODE = "MX_INVALID_FOR";
/** The shape rules of `<const>`. */
export const INVALID_CONST_CODE = "MX_INVALID_CONST";
/** The shape rules of `<define>`. */
export const INVALID_DEFINE_CODE = "MX_INVALID_DEFINE";
/** The shape rules of `<return>`. */
export const INVALID_RETURN_CODE = "MX_INVALID_RETURN";
/** The shape rules of `<try>`. */
export const INVALID_TRY_CODE = "MX_INVALID_TRY";
/** An `import`, `export` or `static` statement core cannot take, or a `<script>` body that does not parse. */
export const INVALID_STATEMENT_CODE = "MX_INVALID_STATEMENT";
/** A tag name the language refuses, or a lowercase tag naming a local variable. */
export const INVALID_TAG_NAME_CODE = "MX_INVALID_TAG_NAME";
/** A capitalized tag with no import or `<define>` in scope. */
export const UNBOUND_COMPONENT_CODE = "MX_UNBOUND_COMPONENT";
/** A tag that cannot be called here: a taglib tag with no template, a data attribute tag rendered as a tag, a template calling its own file the wrong way. */
export const INVALID_TAG_CALL_CODE = "MX_INVALID_TAG_CALL";
/** A `/var` that cannot bind, or a read of one out of scope. */
export const INVALID_TAG_VAR_CODE = "MX_INVALID_TAG_VAR";
/** An attribute tag in a place or shape that is not allowed. */
export const INVALID_ATTRIBUTE_TAG_CODE = "MX_INVALID_ATTRIBUTE_TAG";
/** An attribute tag the callee's contract or `Input` does not declare. */
export const UNKNOWN_ATTRIBUTE_TAG_CODE = "MX_UNKNOWN_ATTRIBUTE_TAG";
/** A required attribute tag that is absent, or absent on some `<if>` path. */
export const MISSING_ATTRIBUTE_TAG_CODE = "MX_MISSING_ATTRIBUTE_TAG";
/** A single attribute tag given twice, or inside `<for>`. */
export const REPEATED_ATTRIBUTE_TAG_CODE = "MX_REPEATED_ATTRIBUTE_TAG";
/** A callee's `Input` (or the file's own) that cannot be read. */
export const INVALID_CALLEE_INPUT_CODE = "MX_INVALID_CALLEE_INPUT";
/** A construct the target or the product cannot express. */
export const UNSUPPORTED_CONSTRUCT_CODE = "MX_UNSUPPORTED_CONSTRUCT";
/** A spread, attribute or body on a tag that emits nothing. */
export const INERT_TAG_SHAPE_CODE = "MX_INERT_TAG_SHAPE";
/** `<effect>`, a reserved name that is not a tag; `<script>` is the effect. */
export const RESERVED_EFFECT_TAG_CODE = "MX_RESERVED_EFFECT_TAG";
/** A write to a `<let>` while the template renders. */
export const LET_WRITE_IN_RENDER_CODE = "MX_LET_WRITE_IN_RENDER";
/** A write to a `<let>` above the tag that declares it. */
export const LET_WRITE_BEFORE_DECLARATION_CODE =
  "MX_LET_WRITE_BEFORE_DECLARATION";
/** A write to a `<const>` above the tag that declares it. */
export const CONST_WRITE_BEFORE_DECLARATION_CODE =
  "MX_CONST_WRITE_BEFORE_DECLARATION";
/** A `for…of` or `for…in` whose left side is a `<let>`. */
export const LET_LOOP_ASSIGNMENT_CODE = "MX_LET_LOOP_ASSIGNMENT";
/** A tag variable read in the attributes of the very tag that declares it (`<const/x=x+1/>`). */
export const TAG_VAR_SELF_READ_CODE = "MX_TAG_VAR_SELF_READ";
/** A `<define>` name read above the tag that declares it. */
export const DEFINE_READ_BEFORE_DECLARATION_CODE =
  "MX_DEFINE_READ_BEFORE_DECLARATION";
/** A write to a `<const>`, a `<for>` parameter or a `<define>` parameter where it is never written. */
export const READONLY_BINDING_WRITE_CODE = "MX_READONLY_BINDING_WRITE";
/** A handler reads a derived `<const>` after writing a `<let>` it depends on. */
export const STALE_DERIVED_READ_CODE = "MX_STALE_DERIVED_READ";
/** Module level code (`static`, `server`, `client`, `export`) names something that exists only while the template renders. */
export const RENDER_ONLY_IN_MODULE_CODE = "MX_RENDER_ONLY_IN_MODULE";
/** A module name declared twice (except permitted `var`/TypeScript merges), or a body tag variable repeating a declaration or its enclosing tag's parameter. */
export const DUPLICATE_DECLARATION_CODE = "MX_DUPLICATE_DECLARATION";
/** An export list names (`static export { q }`) a binding no module statement declares: the module cannot load. */
export const UNDECLARED_EXPORT_CODE = "MX_UNDECLARED_EXPORT";
/** A `.marko` file used as a tag or an import. */
export const UNSUPPORTED_MARKO_FILE_CODE = "MX_UNSUPPORTED_MARKO_FILE";
/** A bad `#id`/`.class` shorthand, or one with no default tag. */
export const INVALID_SHORTHAND_CODE = "MX_INVALID_SHORTHAND";
/** A binding name core reserves. */
export const RESERVED_BINDING_CODE = "MX_RESERVED_BINDING";
/** `content` or `<@content>` on a template tag call: both name the body. */
export const RESERVED_INPUT_CODE = "MX_RESERVED_INPUT";
/** An assignment to an accessor read. */
export const INVALID_ACCESSOR_ASSIGNMENT_CODE =
  "MX_INVALID_ACCESSOR_ASSIGNMENT";
/** A dialect trigger written where its row cannot place it. */
export const INVALID_TRIGGER_USE_CODE = "MX_INVALID_TRIGGER_USE";
/** A trigger, block tag or filter with no lowering hook. */
export const NO_LOWERING_CODE = "MX_NO_LOWERING";

// --- Contract checks at a call site ---

/** An authored tag with no contract, under `unknownTags: "reject"`. */
export const UNKNOWN_TAG_CODE = "MX_UNKNOWN_TAG";
/**
 * A definition that names a reserved tag, from any source: a discovered tag
 * file, an `mx.tags` directory, an `mx.contracts` entry or a `customTags`
 * entry, and a call of a built-in a definition shadows. The definition is
 * dropped.
 */
export const RESERVED_TAG_CODE = "MX_RESERVED_TAG";
/** A contract's `defaultTag` that does not name a tag the parent can use. */
export const INVALID_DEFAULT_TAG_CODE = "MX_INVALID_DEFAULT_TAG";
/** An attribute the tag's contract does not declare. */
export const UNKNOWN_ATTRIBUTE_CODE = "MX_UNKNOWN_ATTRIBUTE";
/** A required attribute that is absent. */
export const MISSING_ATTRIBUTE_CODE = "MX_MISSING_ATTRIBUTE";
/** An attribute value of the wrong type, literalness, enum, atom, member or composite shape. */
export const INVALID_ATTRIBUTE_VALUE_CODE = "MX_INVALID_ATTRIBUTE_VALUE";
/** A body on a tag that takes none. */
export const CONTENT_NOT_ALLOWED_CODE = "MX_CONTENT_NOT_ALLOWED";
/** A tag whose `parents` rule its parent breaks. */
export const PARENT_NOT_ALLOWED_CODE = "MX_PARENT_NOT_ALLOWED";
/** A child tag a parent's `children` contract does not allow. */
export const TAG_NOT_ALLOWED_CODE = "MX_TAG_NOT_ALLOWED";
/** Text where a parent's `children` contract allows none. */
export const TEXT_NOT_ALLOWED_CODE = "MX_TEXT_NOT_ALLOWED";
/** A child the parent's `children` contract allows once, given again. */
export const REPEATED_CHILD_CODE = "MX_REPEATED_CHILD";
/** A child the parent's `children` contract requires, absent. */
export const MISSING_CHILD_CODE = "MX_MISSING_CHILD";
/** A dynamic `<${…}>` tag under a closed `children` contract. */
export const UNCHECKABLE_CHILD_CODE = "MX_UNCHECKABLE_CHILD";
/** A wildcard child one typo from an explicit child of the same parent. */
export const NEAR_EXPLICIT_CHILD_CODE = "MX_NEAR_EXPLICIT_CHILD";

// --- The IR entry: data files ---

/** A structural construct in a file whose consumer does not evaluate it (`structural: "reject"`). */
export const STRUCTURAL_CONSTRUCT_CODE = "MX_STRUCTURAL_CONSTRUCT";
/** Something a data tree cannot hold: a template tag call, `<!doctype>`, a tag variable, a dynamic tag, `<define>`, `<return>`. */
export const NOT_IN_DATA_FILE_CODE = "MX_NOT_IN_DATA_FILE";

// --- Registration and configuration ---

/** A tag contract (`customTags`, `mx.contracts`, a sidecar) with a bad key, contradiction, recursion, wildcard reference or default. */
export const INVALID_CONTRACT_CODE = "MX_INVALID_CONTRACT";
/**
 * A `Dialect.contracts` entry that cannot load: the dialect fails, and every
 * file routed to it reports the error, in the dialect's module at the
 * entry's key. A dialect's `checkContract` that gives its own code wins.
 */
export const INVALID_DIALECT_CONTRACT_CODE = "MX_INVALID_DIALECT_CONTRACT";
/** A sidecar's or an `mx.tags` entry's `parseOptions`. */
export const INVALID_PARSE_OPTIONS_CODE = "MX_INVALID_PARSE_OPTIONS";
/** A project `mx` setting: `mx.tags`, `mx.contracts`, `mx.extensions`, the removed `mx.syntax`, a dialect-owned key. */
export const INVALID_CONFIG_CODE = "MX_INVALID_CONFIG";
/** A project setting the scan cannot apply and ignores: an unknown host, a missing `mx.tags` directory, a manifest or config that does not parse. */
export const IGNORED_CONFIG_CODE = "MX_IGNORED_CONFIG";
/** An `mx.contracts` entry another definition of the same tag shadows. */
export const SHADOWED_CONTRACT_CODE = "MX_SHADOWED_CONTRACT";
/** A sidecar, contracts module, config or dialect module that cannot be resolved or loaded. */
export const MODULE_LOAD_FAILED_CODE = "MX_MODULE_LOAD_FAILED";
/** A dialect's `package.json#mx.dialect` manifest. */
export const INVALID_DIALECT_MANIFEST_CODE = "MX_INVALID_DIALECT_MANIFEST";
/** Two dialects with one id, or two claiming one extension. */
export const DIALECT_CONFLICT_CODE = "MX_DIALECT_CONFLICT";
/** The dialect object: its fields, table overlay, node types, `contractFields`, rows with no hook, the `dialect` option. */
export const INVALID_DIALECT_MODULE_CODE = "MX_INVALID_DIALECT_MODULE";
/** A caller's misuse of a core API that reaches a diagnostic (the `parseFragment` base contract). */
export const INVALID_API_USE_CODE = "MX_INVALID_API_USE";
/** A dialect tag file whose definition has errors, or that the dialect's `tagFile` hook refuses. */
export const TAG_FILE_ERROR_CODE = "MX_TAG_FILE_ERROR";
/** Tag files that call each other in a cycle. */
export const TAG_FILE_CYCLE_CODE = "MX_TAG_FILE_CYCLE";
/** A dialect's file in a tag directory the dialect does not discover. */
export const MISPLACED_TAG_FILE_CODE = "MX_MISPLACED_TAG_FILE";
/** A tag file whose name cannot be a tag name. */
export const INVALID_TAG_FILE_NAME_CODE = "MX_INVALID_TAG_FILE_NAME";
/** A `.tag.ts` sidecar in a dialect tag directory that reads none. */
export const SIDECAR_IGNORED_CODE = "MX_SIDECAR_IGNORED";
/** A dialect tag file whose dotted name a call cannot write as one tag name. */
export const DOTTED_TAG_FILE_NAME_CODE = "MX_DOTTED_TAG_FILE_NAME";

// --- Hooks: the dialect's and the tag author's ---

/**
 * A dialect hook that broke its contract (it threw, returned a malformed
 * value, misused `ctx.*`, or passed a code with MX's `MX_` prefix): the code
 * core gives the error it reports in the hook's place.
 */
export const DIALECT_HOOK_ERROR_CODE = "MX_DIALECT_HOOK_ERROR";
/** A dialect's own error that gave no code: a hook's `ctx.fail`, `unit.fail`, `checkContract`'s `fail`, `explainUnknownTag`. */
export const DIALECT_ERROR_CODE = "MX_DIALECT_ERROR";
/** A dialect's own warning (`unit.warn`) that gave no code. */
export const DIALECT_WARNING_CODE = "MX_DIALECT_WARNING";
/** A custom tag hook (`analyze`, `transform`, `finalize`) that broke its contract: it threw, returned the wrong thing, or misused `ctx.fail` or `ctx.build`. */
export const TAG_HOOK_ERROR_CODE = "MX_TAG_HOOK_ERROR";
/** A custom tag hook's `ctx.fail` that gave no code. */
export const TAG_ERROR_CODE = "MX_TAG_ERROR";
/** A bug in MX, not in the file: an internal invariant broke, or an error reached the diagnostics with no code. */
export const INTERNAL_ERROR_CODE = "MX_INTERNAL_ERROR";

// --- Warnings ---

/** A later attribute of the same name wins over an earlier one. */
export const DUPLICATE_ATTRIBUTE_CODE = "MX_DUPLICATE_ATTRIBUTE";
/** An event attribute whose lowercase name is not a DOM event. */
export const NOT_A_DOM_EVENT_CODE = "MX_NOT_A_DOM_EVENT";
/** A `content` attribute on a `<define>` that has a body, which is the `content`. */
export const DEFINE_CONTENT_DROPPED_CODE = "MX_DEFINE_CONTENT_DROPPED";
/** A `<define>` called with more params than the first, which the call ignores. */
export const DEFINE_EXTRA_PARAMS_CODE = "MX_DEFINE_EXTRA_PARAMS";
/** A lowercase tag that names a binding: the native element renders and the binding is not called. */
export const LOWERCASE_BINDING_NOT_CALLED_CODE =
  "MX_LOWERCASE_BINDING_NOT_CALLED";
/** A callee whose `Input` cannot be read: its attribute tags are planned untyped. */
export const UNREADABLE_CALLEE_INPUT_CODE = "MX_UNREADABLE_CALLEE_INPUT";
/** A body passed to a tag that never reads it. */
export const BODY_DROPPED_CODE = "MX_BODY_DROPPED";
/** An attribute tag passed to a tag that never reads it. */
export const ATTRIBUTE_TAG_DROPPED_CODE = "MX_ATTRIBUTE_TAG_DROPPED";

// --- Parse errors: the front end's rules ---

/** A second expression after the one an expression position holds. */
export const EXPECTED_SINGLE_EXPRESSION_CODE = "MX_EXPECTED_SINGLE_EXPRESSION";
/** Any other expression the expression parser cannot read. */
export const PARSE_EXPRESSION_CODE = "MX_PARSE_EXPRESSION";
/** A line that continues attributes with no tag to continue (a bare `,`). */
export const TAG_NAME_MISSING_CODE = "MX_TAG_NAME_MISSING";
/** A statement keyword where the body is HTML. */
export const STATEMENT_IN_HTML_MODE_CODE = "MX_STATEMENT_IN_HTML_MODE";
/** A tag name the front end reserves. */
export const RESERVED_TAG_NAME_CODE = "MX_RESERVED_TAG_NAME";
/** An attribute tag at the root of the file. */
export const ATTRIBUTE_TAG_AT_ROOT_CODE = "MX_ATTRIBUTE_TAG_AT_ROOT";
/** An unescaped `${` inside a quoted attribute value. */
export const UNESCAPED_PLACEHOLDER_IN_ATTRIBUTE_VALUE_CODE =
  "MX_UNESCAPED_PLACEHOLDER_IN_ATTRIBUTE_VALUE";
/** Tag type arguments that do not match the tag's type parameters. */
export const TAG_TYPES_MISMATCH_CODE = "MX_TAG_TYPES_MISMATCH";
/**
 * A `#id` or `.class` shorthand, or an implicit `div`, in a file whose
 * dialect set `tagShorthands: false` (the syntax table field). Positioned at
 * the `#` or the leading `.`. A trailing or doubled `.`, or a `.` right after
 * a `${…}` in such a file, is `MX_INVALID_TAG_NAME`.
 */
export const NO_TAG_SHORTHAND_CODE = "MX_NO_TAG_SHORTHAND";
/** Input that ends inside a concise open delimiter. */
export const INPUT_ENDS_IN_DELIMITER_CODE = "MX_INPUT_ENDS_IN_DELIMITER";
/** An internal error of the front end. */
export const FRONT_END_INTERNAL_CODE = "MX_FRONT_END_INTERNAL";

/**
 * The template parser's own codes (`MxParseError.code`), each reported as
 * `MX_PARSE_<CODE>`. The prefix keeps them apart from the front end's rules:
 * the template parser's `RESERVED_TAG_NAME` is not `MX_RESERVED_TAG_NAME`.
 */
export const TEMPLATE_PARSE_ERRORS = [
  "EXTRA_CLOSING_TAG",
  "INVALID_ATTRIBUTE_ARGUMENT",
  "INVALID_ATTRIBUTE_NAME",
  "INVALID_ATTRIBUTE_VALUE",
  "INVALID_CHARACTER",
  "INVALID_CODE_AFTER_SEMICOLON",
  "INVALID_EXPRESSION",
  "INVALID_INDENTATION",
  "INVALID_LINE_START",
  "INVALID_REGULAR_EXPRESSION",
  "INVALID_STRING",
  "INVALID_TAG_ARGUMENT",
  "INVALID_TAG_SHORTHAND",
  "INVALID_TEMPLATE_STRING",
  "MALFORMED_CDATA",
  "MALFORMED_CLOSE_TAG",
  "MALFORMED_COMMENT",
  "MALFORMED_DECLARATION",
  "MALFORMED_DOCUMENT_TYPE",
  "MALFORMED_OPEN_TAG",
  "MALFORMED_PLACEHOLDER",
  "MISMATCHED_CLOSING_TAG",
  "MISSING_END_TAG",
  "MISSING_TAG_VARIABLE",
  "RESERVED_TAG_NAME",
  "ROOT_TAG_ONLY",
  "INVALID_TAG_PARAMS",
  "INVALID_TAG_TYPES",
  "INVALID_ATTR_TYPE_PARAMS",
  "AMBIGUOUS_ATTRIBUTE_VALUE",
  "INVALID_HTML_COMMENT",
  "MALFORMED_BLOCK_TAG",
  "MALFORMED_FILTER",
] as const;

/** A template-parser code (`MALFORMED_OPEN_TAG`). */
export type TemplateParseError = (typeof TEMPLATE_PARSE_ERRORS)[number];

/** `MX_PARSE_<CODE>` of a template-parser code. */
export type TemplateParseCode = `MX_PARSE_${TemplateParseError}`;

/** The tag params of a tag head that do not parse (`stock-parser.ts`). */
export const PARSE_INVALID_TAG_PARAMS_CODE =
  "MX_PARSE_INVALID_TAG_PARAMS" satisfies TemplateParseCode;

/** The front end's own `MX_*` rules, which keep their codes. */
const FRONT_END_CODES: ReadonlySet<string> = new Set([
  TAG_NAME_MISSING_CODE,
  STATEMENT_IN_HTML_MODE_CODE,
  RESERVED_TAG_NAME_CODE,
  ATTRIBUTE_TAG_AT_ROOT_CODE,
  UNESCAPED_PLACEHOLDER_IN_ATTRIBUTE_VALUE_CODE,
  TAG_TYPES_MISMATCH_CODE,
  INPUT_ENDS_IN_DELIMITER_CODE,
  FRONT_END_INTERNAL_CODE,
  NO_TAG_SHORTHAND_CODE,
  // The template parser reports it for `tagShorthands: false`; lowering
  // raises the same code for a local variable named as a tag.
  INVALID_TAG_NAME_CODE,
]);

const TEMPLATE_CODES: ReadonlySet<string> = new Set(TEMPLATE_PARSE_ERRORS);

/**
 * The stable code of a parse error, by the parser's own `MxParseError.code`:
 * a template-parser code becomes `MX_PARSE_<CODE>`; a Babel reason becomes
 * `MX_PARSE_EXPRESSION`, except `BABEL_ParseExpressionExpectsEOF`, which is
 * `MX_EXPECTED_SINGLE_EXPRESSION`; a front-end `MX_*` rule keeps its own.
 * `undefined` for a value that is none of these (an error core builds
 * itself carries its own code).
 */
export function parseDiagnosticCode(
  mxCode: unknown,
): MxDiagnosticCode | undefined {
  if (typeof mxCode !== "string") return undefined;
  if (mxCode === "BABEL_ParseExpressionExpectsEOF") {
    return EXPECTED_SINGLE_EXPRESSION_CODE;
  }
  if (mxCode.startsWith("BABEL_")) return PARSE_EXPRESSION_CODE;
  if (TEMPLATE_CODES.has(mxCode))
    return `MX_PARSE_${mxCode}` as MxDiagnosticCode;
  if (FRONT_END_CODES.has(mxCode)) return mxCode as MxDiagnosticCode;
  return undefined;
}

/**
 * Whether a code a dialect or tag hook passes is MX's own: a code starting
 * with `MX_` is refused as a hook contract error, so a consumer can trust
 * that an `MX_` code is MX's rule. Any other non-empty string is the
 * hook's.
 */
export function isReservedHookCode(code: string): boolean {
  return code.startsWith("MX_");
}

/** The text of the hook contract error for a reserved code. */
export function reservedHookCodeMessage(
  code: string,
  owner = "the dialect's",
): string {
  return `code \`${code}\` starts with \`MX_\`, which is MX's own prefix for its diagnostic codes; use ${owner} own prefix`;
}

/**
 * The codes a dialect may not rename (`Dialect.diagnosticCodes`): a bug in
 * MX, and a dialect hook that broke its contract. Both say something about
 * MX or the hook, never about the author's file, so a tool that triages
 * them must always find MX's own code.
 */
export const UNRENAMEABLE_CODES: ReadonlySet<string> = new Set([
  INTERNAL_ERROR_CODE,
  DIALECT_HOOK_ERROR_CODE,
]);

let knownCodes: ReadonlySet<string> | undefined;

/** Whether `code` is one of the codes core raises ({@link MX_DIAGNOSTIC_CODES}). */
export function isMxDiagnosticCode(code: string): code is MxDiagnosticCode {
  knownCodes ??= new Set(MX_DIAGNOSTIC_CODES.map((entry) => entry.code));
  return knownCodes.has(code);
}

const effective = new WeakMap<object, Readonly<Record<string, string>>>();

/**
 * The renames of a dialect's `diagnosticCodes` that apply: the map without its
 * `MX_DIALECT_ERROR` and `MX_DIALECT_WARNING` entries. Those codes report the
 * dialect itself (an error or warning it gave no code to), so MX keeps them:
 * the entries load, and are ignored.
 */
export function effectiveDiagnosticCodes(
  map: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  let kept = effective.get(map);
  if (kept === undefined) {
    const {
      [DIALECT_ERROR_CODE]: _error,
      [DIALECT_WARNING_CODE]: _warning,
      ...rest
    } = map;
    kept = rest;
    effective.set(map, kept);
  }
  return kept;
}

/**
 * `diagnostics` with each core code the dialect's `diagnosticCodes` map names
 * replaced by its value; nothing else changes. A code the map does not name
 * (a hook's own code, an unlisted core code), `MX_DIALECT_ERROR`, `MX_DIALECT_WARNING` and a
 * diagnostic with no code stay as they are. Returns `diagnostics` itself when
 * there is nothing to rename. Call it once, on the final list.
 */
export function renameDiagnosticCodes<T extends { code?: string }>(
  diagnostics: readonly T[],
  map: Readonly<Record<string, string>> | undefined,
): readonly T[] {
  if (map === undefined) return diagnostics;
  const names = effectiveDiagnosticCodes(map);
  let changed = false;
  const renamed = diagnostics.map((diagnostic) => {
    const code = diagnostic.code;
    if (code === undefined || !Object.hasOwn(names, code)) return diagnostic;
    changed = true;
    return { ...diagnostic, code: names[code] as string };
  });
  return changed ? renamed : diagnostics;
}

/** One entry of {@link MX_DIAGNOSTIC_CODES}. @unstable */
export interface MxDiagnosticCodeEntry {
  /** The code, as `IrDiagnostic.code` carries it. */
  readonly code: string;
  /** Whether the code is reported as an error or a warning. */
  readonly severity: "error" | "warning";
  /** The rule the code names, in one line. */
  readonly summary: string;
}

type Row = readonly [code: string, summary: string];

const errors = (rows: readonly Row[]): MxDiagnosticCodeEntry[] =>
  rows.map(([code, summary]) => ({ code, severity: "error", summary }));

const warnings = (rows: readonly Row[]): MxDiagnosticCodeEntry[] =>
  rows.map(([code, summary]) => ({ code, severity: "warning", summary }));

/**
 * Every diagnostic code MX reports from `lowerSource` and
 * `checkDialectFile`, with its severity and the rule it names. Frozen. A
 * code is never renamed or reused for another rule; new codes are added.
 *
 * @unstable
 */
export const MX_DIAGNOSTIC_CODES: readonly MxDiagnosticCodeEntry[] =
  Object.freeze(
    [
      ...errors([
        [
          INVALID_ATTRIBUTE_CODE,
          "an attribute name, form, value or argument list the language rejects",
        ],
        [
          INVALID_BOUND_ATTRIBUTE_CODE,
          "`:=` on something that is not an identifier or member expression",
        ],
        [DUPLICATE_VALUE_ATTRIBUTE_CODE, "a second value attribute"],
        [
          UNSUPPORTED_TAG_ARGUMENTS_CODE,
          "tag arguments the tag does not take: beside attributes or a body, several or a spread on a named custom tag, any on an attribute tag",
        ],
        [INVALID_EXPRESSION_CODE, "an expression lowering cannot read"],
        [
          INVALID_IF_CODE,
          "the shape rules of `<if>`, `<else-if>` and `<else>`",
        ],
        [INVALID_FOR_CODE, "the shape rules of `<for>`"],
        [INVALID_CONST_CODE, "the shape rules of `<const>`"],
        [INVALID_DEFINE_CODE, "the shape rules of `<define>`"],
        [INVALID_RETURN_CODE, "the shape rules of `<return>`"],
        [INVALID_TRY_CODE, "the shape rules of `<try>`"],
        [
          INVALID_STATEMENT_CODE,
          "an `import`, `export` or `static` statement core cannot take, or a `<script>` body that does not parse",
        ],
        [INVALID_TAG_NAME_CODE, "a tag name the language refuses"],
        [
          UNBOUND_COMPONENT_CODE,
          "a capitalized tag with no import or `<define>` in scope",
        ],
        [INVALID_TAG_CALL_CODE, "a tag that cannot be called here"],
        [
          INVALID_TAG_VAR_CODE,
          "a `/var` that cannot bind, or is read out of scope",
        ],
        [
          INVALID_ATTRIBUTE_TAG_CODE,
          "an attribute tag in a place or shape that is not allowed",
        ],
        [
          UNKNOWN_ATTRIBUTE_TAG_CODE,
          "an attribute tag the contract or `Input` does not declare",
        ],
        [MISSING_ATTRIBUTE_TAG_CODE, "a required attribute tag that is absent"],
        [
          REPEATED_ATTRIBUTE_TAG_CODE,
          "a single attribute tag given twice, or inside `<for>`",
        ],
        [INVALID_CALLEE_INPUT_CODE, "a callee's `Input` that cannot be read"],
        [
          UNSUPPORTED_CONSTRUCT_CODE,
          "a construct the target or the product cannot express",
        ],
        [
          INERT_TAG_SHAPE_CODE,
          "a spread, attribute or body on a tag that emits nothing",
        ],
        [
          RESERVED_EFFECT_TAG_CODE,
          "`<effect>`, which is not a tag; `<script>` runs a body after render",
        ],
        [
          LET_WRITE_IN_RENDER_CODE,
          "a write to a `<let>` while the template renders",
        ],
        [
          LET_WRITE_BEFORE_DECLARATION_CODE,
          "a write to a `<let>` above the tag that declares it",
        ],
        [
          CONST_WRITE_BEFORE_DECLARATION_CODE,
          "a write to a `<const>` above the tag that declares it",
        ],
        [
          LET_LOOP_ASSIGNMENT_CODE,
          "a `for…of` or `for…in` whose left side is a `<let>`",
        ],
        [
          TAG_VAR_SELF_READ_CODE,
          "a tag variable read in the attributes of the very tag that declares it",
        ],
        [
          DEFINE_READ_BEFORE_DECLARATION_CODE,
          "a `<define>` name read above the tag that declares it",
        ],
        [
          READONLY_BINDING_WRITE_CODE,
          "a write to a `<const>`, a `<for>` parameter or a `<define>` parameter where it is never written",
        ],
        [
          STALE_DERIVED_READ_CODE,
          "a handler reads a derived `<const>` after writing a `<let>` it depends on",
        ],
        [
          RENDER_ONLY_IN_MODULE_CODE,
          "module level code names a tag variable, `input`, `$global` or `$signal`, which exist only while the template renders",
        ],
        [
          DUPLICATE_DECLARATION_CODE,
          "a module name declared twice (except permitted var/TypeScript merges), or a body tag variable repeating a declaration or its enclosing tag's parameter",
        ],
        [
          UNDECLARED_EXPORT_CODE,
          "an export list names a binding no module statement declares",
        ],
        [
          UNSUPPORTED_MARKO_FILE_CODE,
          "a `.marko` file used as a tag or an import",
        ],
        [INVALID_SHORTHAND_CODE, "a bad `#id`/`.class` shorthand"],
        [RESERVED_BINDING_CODE, "a binding name core reserves"],
        [
          RESERVED_INPUT_CODE,
          "`content` or `<@content>` on a template tag call",
        ],
        [INVALID_ACCESSOR_ASSIGNMENT_CODE, "an assignment to an accessor read"],
        [
          INVALID_TRIGGER_USE_CODE,
          "a trigger written where its row cannot place it",
        ],
        [
          NO_LOWERING_CODE,
          "a trigger, block tag or filter with no lowering hook",
        ],
        [
          UNKNOWN_TAG_CODE,
          'an authored tag with no contract, under `unknownTags: "reject"`',
        ],
        [RESERVED_TAG_CODE, "a definition that names a reserved tag"],
        [
          INVALID_DEFAULT_TAG_CODE,
          "a contract's `defaultTag` the parent cannot use",
        ],
        [UNKNOWN_ATTRIBUTE_CODE, "an attribute the contract does not declare"],
        [MISSING_ATTRIBUTE_CODE, "a required attribute that is absent"],
        [
          INVALID_ATTRIBUTE_VALUE_CODE,
          "an attribute value of the wrong type or shape",
        ],
        [CONTENT_NOT_ALLOWED_CODE, "a body on a tag that takes none"],
        [
          PARENT_NOT_ALLOWED_CODE,
          "a tag whose `parents` rule its parent breaks",
        ],
        [
          TAG_NOT_ALLOWED_CODE,
          "a child tag the parent's `children` contract does not allow",
        ],
        [
          TEXT_NOT_ALLOWED_CODE,
          "text where the parent's `children` contract allows none",
        ],
        [REPEATED_CHILD_CODE, "a child the parent allows once, given again"],
        [MISSING_CHILD_CODE, "a child the parent requires, absent"],
        [
          UNCHECKABLE_CHILD_CODE,
          "a dynamic tag under a closed `children` contract",
        ],
        [
          NEAR_EXPLICIT_CHILD_CODE,
          "a wildcard child one typo from an explicit child",
        ],
        [
          STRUCTURAL_CONSTRUCT_CODE,
          "a structural construct in a file whose consumer does not evaluate it",
        ],
        [NOT_IN_DATA_FILE_CODE, "something a data tree cannot hold"],
        [
          INVALID_CONTRACT_CODE,
          "a tag contract with a bad key, contradiction, recursion or reference",
        ],
        [
          INVALID_DIALECT_CONTRACT_CODE,
          "a `Dialect.contracts` entry that cannot load",
        ],
        [
          INVALID_PARSE_OPTIONS_CODE,
          "a `parseOptions` value the scan cannot read",
        ],
        [INVALID_CONFIG_CODE, "a project `mx` setting"],
        [MODULE_LOAD_FAILED_CODE, "a module that cannot be resolved or loaded"],
        [
          INVALID_DIALECT_MANIFEST_CODE,
          "a dialect's `package.json#mx.dialect` manifest",
        ],
        [
          DIALECT_CONFLICT_CODE,
          "two dialects with one id, or claiming one extension",
        ],
        [
          INVALID_DIALECT_MODULE_CODE,
          "a dialect module, its table, node types or the `dialect` option",
        ],
        [INVALID_API_USE_CODE, "a caller's misuse of a core API"],
        [
          TAG_FILE_ERROR_CODE,
          "a dialect tag file with errors, or one its `tagFile` hook refuses",
        ],
        [TAG_FILE_CYCLE_CODE, "tag files that call each other in a cycle"],
        [
          INVALID_TAG_FILE_NAME_CODE,
          "a tag file whose name cannot be a tag name",
        ],
        [DIALECT_HOOK_ERROR_CODE, "a dialect hook that broke its contract"],
        [DIALECT_ERROR_CODE, "a dialect's own error that gave no code"],
        [TAG_HOOK_ERROR_CODE, "a custom tag hook that broke its contract"],
        [TAG_ERROR_CODE, "a custom tag hook's `ctx.fail` that gave no code"],
        [INTERNAL_ERROR_CODE, "a bug in MX, not in the file"],
        [
          EXPECTED_SINGLE_EXPRESSION_CODE,
          "a second expression after the one an expression position holds",
        ],
        [PARSE_EXPRESSION_CODE, "an expression that does not parse"],
        [
          TAG_NAME_MISSING_CODE,
          "a line that continues attributes with no tag to continue",
        ],
        [
          STATEMENT_IN_HTML_MODE_CODE,
          "a statement keyword where the body is HTML",
        ],
        [RESERVED_TAG_NAME_CODE, "a tag name the front end reserves"],
        [
          NO_TAG_SHORTHAND_CODE,
          "a `#id` or `.class` shorthand where the dialect turned tag shorthands off",
        ],
        [
          ATTRIBUTE_TAG_AT_ROOT_CODE,
          "an attribute tag at the root of the file",
        ],
        [
          UNESCAPED_PLACEHOLDER_IN_ATTRIBUTE_VALUE_CODE,
          "an unescaped `${` in a quoted attribute value",
        ],
        [
          TAG_TYPES_MISMATCH_CODE,
          "tag type arguments that do not match the tag's type parameters",
        ],
        [
          INPUT_ENDS_IN_DELIMITER_CODE,
          "input that ends inside a concise open delimiter",
        ],
        [
          FRONT_END_INTERNAL_CODE,
          "an internal error of the parser's front end",
        ],
        ...TEMPLATE_PARSE_ERRORS.map(
          (code): Row => [
            `MX_PARSE_${code}`,
            `the template parser's \`${code}\``,
          ],
        ),
      ]),
      ...warnings([
        [
          IGNORED_CONFIG_CODE,
          "a project setting the scan cannot apply and ignores",
        ],
        [
          SHADOWED_CONTRACT_CODE,
          "an `mx.contracts` entry another definition shadows",
        ],
        [
          MISPLACED_TAG_FILE_CODE,
          "a dialect file in a tag directory the dialect does not discover",
        ],
        [
          SIDECAR_IGNORED_CODE,
          "a sidecar in a dialect tag directory that reads none",
        ],
        [
          DOTTED_TAG_FILE_NAME_CODE,
          "a dialect tag file whose dotted name a call cannot write",
        ],
        [DIALECT_WARNING_CODE, "a dialect's own warning that gave no code"],
        [DUPLICATE_ATTRIBUTE_CODE, "a later attribute of the same name wins"],
        [
          NOT_A_DOM_EVENT_CODE,
          "an event attribute whose lowercase name is not a DOM event",
        ],
        [
          DEFINE_CONTENT_DROPPED_CODE,
          "a `content` attribute on a `<define>` that has a body, which is the `content`",
        ],
        [
          DEFINE_EXTRA_PARAMS_CODE,
          "a `<define>` param past the first, which the call ignores",
        ],
        [
          LOWERCASE_BINDING_NOT_CALLED_CODE,
          "a lowercase tag naming a binding, which is not called",
        ],
        [UNREADABLE_CALLEE_INPUT_CODE, "a callee whose `Input` cannot be read"],
        [BODY_DROPPED_CODE, "a body passed to a tag that never reads it"],
        [
          ATTRIBUTE_TAG_DROPPED_CODE,
          "an attribute tag passed to a tag that never reads it",
        ],
      ]),
    ].map((entry) => Object.freeze(entry)),
  );

/** Every code core raises: a constant of this module, or `MX_PARSE_<CODE>`. */
export type MxDiagnosticCode =
  | typeof INVALID_ATTRIBUTE_CODE
  | typeof INVALID_BOUND_ATTRIBUTE_CODE
  | typeof DUPLICATE_VALUE_ATTRIBUTE_CODE
  | typeof UNSUPPORTED_TAG_ARGUMENTS_CODE
  | typeof INVALID_EXPRESSION_CODE
  | typeof INVALID_IF_CODE
  | typeof INVALID_FOR_CODE
  | typeof INVALID_CONST_CODE
  | typeof INVALID_DEFINE_CODE
  | typeof INVALID_RETURN_CODE
  | typeof INVALID_TRY_CODE
  | typeof INVALID_STATEMENT_CODE
  | typeof INVALID_TAG_NAME_CODE
  | typeof UNBOUND_COMPONENT_CODE
  | typeof INVALID_TAG_CALL_CODE
  | typeof INVALID_TAG_VAR_CODE
  | typeof INVALID_ATTRIBUTE_TAG_CODE
  | typeof UNKNOWN_ATTRIBUTE_TAG_CODE
  | typeof MISSING_ATTRIBUTE_TAG_CODE
  | typeof REPEATED_ATTRIBUTE_TAG_CODE
  | typeof INVALID_CALLEE_INPUT_CODE
  | typeof UNSUPPORTED_CONSTRUCT_CODE
  | typeof INERT_TAG_SHAPE_CODE
  | typeof RESERVED_EFFECT_TAG_CODE
  | typeof LET_WRITE_IN_RENDER_CODE
  | typeof LET_WRITE_BEFORE_DECLARATION_CODE
  | typeof CONST_WRITE_BEFORE_DECLARATION_CODE
  | typeof LET_LOOP_ASSIGNMENT_CODE
  | typeof TAG_VAR_SELF_READ_CODE
  | typeof DEFINE_READ_BEFORE_DECLARATION_CODE
  | typeof READONLY_BINDING_WRITE_CODE
  | typeof STALE_DERIVED_READ_CODE
  | typeof RENDER_ONLY_IN_MODULE_CODE
  | typeof DUPLICATE_DECLARATION_CODE
  | typeof UNDECLARED_EXPORT_CODE
  | typeof UNSUPPORTED_MARKO_FILE_CODE
  | typeof INVALID_SHORTHAND_CODE
  | typeof RESERVED_BINDING_CODE
  | typeof RESERVED_INPUT_CODE
  | typeof INVALID_ACCESSOR_ASSIGNMENT_CODE
  | typeof INVALID_TRIGGER_USE_CODE
  | typeof NO_LOWERING_CODE
  | typeof UNKNOWN_TAG_CODE
  | typeof RESERVED_TAG_CODE
  | typeof INVALID_DEFAULT_TAG_CODE
  | typeof UNKNOWN_ATTRIBUTE_CODE
  | typeof MISSING_ATTRIBUTE_CODE
  | typeof INVALID_ATTRIBUTE_VALUE_CODE
  | typeof CONTENT_NOT_ALLOWED_CODE
  | typeof PARENT_NOT_ALLOWED_CODE
  | typeof TAG_NOT_ALLOWED_CODE
  | typeof TEXT_NOT_ALLOWED_CODE
  | typeof REPEATED_CHILD_CODE
  | typeof MISSING_CHILD_CODE
  | typeof UNCHECKABLE_CHILD_CODE
  | typeof NEAR_EXPLICIT_CHILD_CODE
  | typeof STRUCTURAL_CONSTRUCT_CODE
  | typeof NOT_IN_DATA_FILE_CODE
  | typeof INVALID_CONTRACT_CODE
  | typeof INVALID_DIALECT_CONTRACT_CODE
  | typeof INVALID_PARSE_OPTIONS_CODE
  | typeof INVALID_CONFIG_CODE
  | typeof IGNORED_CONFIG_CODE
  | typeof SHADOWED_CONTRACT_CODE
  | typeof MODULE_LOAD_FAILED_CODE
  | typeof INVALID_DIALECT_MANIFEST_CODE
  | typeof DIALECT_CONFLICT_CODE
  | typeof INVALID_DIALECT_MODULE_CODE
  | typeof INVALID_API_USE_CODE
  | typeof TAG_FILE_ERROR_CODE
  | typeof TAG_FILE_CYCLE_CODE
  | typeof MISPLACED_TAG_FILE_CODE
  | typeof INVALID_TAG_FILE_NAME_CODE
  | typeof SIDECAR_IGNORED_CODE
  | typeof DOTTED_TAG_FILE_NAME_CODE
  | typeof DIALECT_HOOK_ERROR_CODE
  | typeof DIALECT_ERROR_CODE
  | typeof DIALECT_WARNING_CODE
  | typeof TAG_HOOK_ERROR_CODE
  | typeof TAG_ERROR_CODE
  | typeof INTERNAL_ERROR_CODE
  | typeof DUPLICATE_ATTRIBUTE_CODE
  | typeof NOT_A_DOM_EVENT_CODE
  | typeof DEFINE_CONTENT_DROPPED_CODE
  | typeof DEFINE_EXTRA_PARAMS_CODE
  | typeof LOWERCASE_BINDING_NOT_CALLED_CODE
  | typeof UNREADABLE_CALLEE_INPUT_CODE
  | typeof BODY_DROPPED_CODE
  | typeof ATTRIBUTE_TAG_DROPPED_CODE
  | typeof EXPECTED_SINGLE_EXPRESSION_CODE
  | typeof PARSE_EXPRESSION_CODE
  | typeof TAG_NAME_MISSING_CODE
  | typeof STATEMENT_IN_HTML_MODE_CODE
  | typeof RESERVED_TAG_NAME_CODE
  | typeof NO_TAG_SHORTHAND_CODE
  | typeof ATTRIBUTE_TAG_AT_ROOT_CODE
  | typeof UNESCAPED_PLACEHOLDER_IN_ATTRIBUTE_VALUE_CODE
  | typeof TAG_TYPES_MISMATCH_CODE
  | typeof INPUT_ENDS_IN_DELIMITER_CODE
  | typeof FRONT_END_INTERNAL_CODE
  | TemplateParseCode;
