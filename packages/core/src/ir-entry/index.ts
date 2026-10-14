/**
 * The IR entry point (decision 204): parse, lower, check and return core's
 * IR, for a consumer that interprets the tree itself (a dialect such as
 * Mesh) rather than emitting a host's code. Replaces `@mxlang/data`'s
 * `parseData`: with `tagRules: "none"`, every diagnostic it reported is
 * reported at the same text and position (the default `html` rules reject
 * files `parseData` accepted, such as `<input><child/></input>`).
 *
 * An error means `ir: undefined` (no partial IR) and every independent error
 * the source has, each positioned, earliest first: every parse error (the
 * parser recovers and reports several), and, once the source lowers, every
 * check reject, structural hit and unknown tag (`checks.ts`). Lowering stops
 * at its first error by design, so a lowering error (`parents`/`children`, a
 * bad attribute) is the one error of its kind; under `unknownTags: "reject"`
 * the source's unknown tags are still listed beside it. No input makes
 * `lowerSource` throw: an error with no position (a bug in core) is reported
 * at 1:0 with an `internal error: ` prefix, and a user-facing one that has
 * none with `unpositioned error: `. Warnings are collected and returned
 * alongside the IR.
 *
 * @unstable
 */

import { readFileSync } from "node:fs";
import { WEB_ELEMENTS } from "@mxlang/web-elements";
import {
  compileSource,
  type HostOptions,
  tagRulesDecided,
} from "../compile.ts";
import { claimedFields } from "../contract-fields.ts";
import { codedError, type MxWarning, type TranslateError } from "../core.ts";
import {
  type CustomTag,
  registrationView,
  tagOccurrenceOf,
  withoutCollected,
} from "../custom-tags.ts";
import type { HostDeclarations } from "../declarations.ts";
import {
  RESERVED_TAG_CODE,
  renameDiagnosticCodes,
  UNKNOWN_TAG_CODE,
} from "../diagnostic-codes.ts";
import type { Ir } from "../ir.ts";
import {
  CORE_TAG_DISCOVERY,
  callerTagDiscovery,
  reservedRefusal,
} from "../scan.ts";
import {
  type Dialect,
  dialectCustomTags,
  dialectTagRules,
  explicitSyntaxOf,
  resolveSyntaxOf,
  type SyntaxTable,
} from "../syntax-table.ts";
import {
  type TagRulesPreset,
  taglibsOfRules,
  tagRulesPreset,
} from "../tag-presets.ts";
import { createTargetLookup, type TargetLookup } from "../target-descriptor.ts";
import { scanAuthoredTags } from "./authored-tags.ts";
import { checkIr, labelInside, unknownTagMessage } from "./checks.ts";
import {
  builtinTagNames,
  DEFAULT_TAG,
  entryDeclarations,
} from "./declarations.ts";
import {
  errorDiagnostics,
  flattenErrors,
  type IrDiagnostic,
  lineStartsOf,
  mergeDiagnostics,
  toDiagnostic,
} from "./diagnostics.ts";
import { finishIr, type SpannedIr } from "./spans.ts";
// Registers the dialect tag-file reader with the scan (side effect).
import "../tag-file.ts";
import { type Explainer, explainerFor } from "./unknown-tag-view.ts";

export type {
  IrDiagnostic,
  IrDiagnosticEdit,
  IrDiagnosticEnd,
  IrDiagnosticFix,
} from "./diagnostics.ts";
export type { Spanned, SpannedIr } from "./spans.ts";

/** @unstable */
export interface LowerSourceOptions {
  /**
   * Contract-only custom tags (decision 130), by call name. A name core
   * reserves (`if`, `for`, `try`, …) cannot be defined: the definition is
   * dropped, the call lowers as core's construct, and each call site is an
   * `MX_RESERVED_TAG` error (the name's 1:0 when it is never called). A name
   * the file's dialect reserves is refused the same way, unless the call
   * passes that dialect as `dialect`: its own front end's definitions are
   * the dialect's.
   */
  customTags?: Record<string, CustomTag>;
  /**
   * The dialect, or a bare syntax table (decision 182 addendum 5), for a
   * consumer that builds its own (Mesh passes its dialect, hooks included);
   * omitted, the dialect the file's extension routes to (decision 212). A
   * trigger, block tag or filter nothing lowers (a `{ call }` trigger with
   * no `lowerTrigger`) is a positioned diagnostic ("`<id>` trigger has no
   * lowering yet").
   */
  dialect?: SyntaxTable | Dialect;
  /**
   * The tag rules preset the source parses under (decision 204; ruling 209:
   * an option of this function only, never a project or host setting).
   * Omitted, the dialect's own `tagRules` (the `dialect` option's, else the
   * one the file routes to), else `"html"` (decision 212 item 8: a dialect
   * that states no tag rules gets the full HTML rules): the web elements'
   * parse rules (void, raw text, preserved whitespace) and core's whole
   * taglib. `"markup"`: the same
   * parse rules with core's statement tags only. `"none"` (Mesh's): no native
   * element rules, so `script`, `input` or `title` is an ordinary tag whose
   * body parses as markup.
   */
  tagRules?: TagRulesPreset;
  /**
   * What the unnamed tag (`<#id>`, `<.class>`) stands for in place of the
   * built-in `object` (decision 145), already validated.
   */
  defaultTag?: string;
  /**
   * Omitted, the dialect's own `structural` (the `dialect` option's, else the
   * one the file routes to), else `"pass"`.
   *
   * `"pass"` keeps the structural constructs — text, `${}`,
   * `<if>`/`<for>`/`<const>`, `import`/`export`/`static` — in the IR for the
   * consumer to interpret. Comments are never structural: under either value
   * a `//` line or `<!-- -->` stays in the IR as its `Comment` node
   * (decision 131 addendum 5). `"reject"` makes each structural construct a
   * positioned error ("the data tree is static; this file's consumer does
   * not evaluate `<if>`"), for a consumer that wants tags and attributes
   * only and must not silently ignore an `<if>` it never reads. A
   * structural hit and a check error are ordered by position.
   */
  structural?: "pass" | "reject";
  /**
   * Whether a top-level `import` passes. Omitted, the dialect's own `imports`
   * (the `dialect` option's, else the one the file routes to), else the
   * effective `structural`. `"pass"` with `structural: "reject"` keeps control
   * flow, `export` and `static` rejected and returns the imports in
   * `ir.imports`. `"reject"` with `structural: "pass"` rejects only the
   * `import`s.
   */
  imports?: "pass" | "reject";
  /**
   * Omitted, the dialect's own `unknownTags` (the `dialect` option's, else
   * the one the file routes to), else `"allow"`.
   *
   * `"allow"` keeps the open set of decision 131: a tag with no
   * entry in `customTags` is accepted. `"reject"` closes it: any tag, at any
   * depth, whose name has no entry in `customTags` (and is not the built-in
   * `object`) is a positioned error naming the tag, with a
   * nearest-declared-name hint when one is close. An unknown parent is
   * reported before its children's `parents`/`children` errors, and the
   * errors inside an unknown tag are labelled, never dropped (decision 161).
   */
  unknownTags?: "allow" | "reject";
  /**
   * Whether TypeScript types are erased from the nodes before the source
   * lowers. The default (`true`, or omitted) erases them: an arrow's
   * parameter and return annotations are gone from its `node`, and a
   * top-level `as`, `!`, `satisfies`, `<T>x` or `x<T>` is replaced by its
   * operand (the `node`, `span` and `code` are the operand's). `Expr.code` is sliced
   * from the source either way, so annotations inside an expression stay in
   * it. `false` keeps the authored TypeScript in the nodes a dialect's hooks
   * see (`TSTypeAnnotation`, `returnType`, `TSAsExpression`, …), for a
   * dialect whose `nodeType.lower`, contract hooks or `afterLower` read
   * types.
   *
   * With `false`, an assertion stays around the value, so an attribute
   * whose value is an assertion over a literal (`a=("s" as const)`) is
   * `dynamic` with shape `other` rather than `static`, `boolean`, `object`,
   * `array` or `string`, and a contract's `type: "expression"` check follows
   * that kind (`a=("s" as const)` is refused by default, accepted with
   * `false`). Every other check of core looks through TypeScript assertions
   * (`as`, `satisfies`, `!`, `<T>x`, `x<T>`) and gives the default's
   * diagnostics, positions included: the bound-attribute check
   * (`v:=(y as any)`) and a contract's `string`, `number`, `boolean`, `enum`,
   * `literalOnly`, `array`, `items`, `function`, `atom` and `member` checks. An
   * attribute's `span` ends at the operand either way, so with `false` it does
   * not contain the wider `span` of its value (for `a=(1 as number)`, the
   * attribute's span is `a=(1` and its value's is `1 as number`).
   * A tag-file hook's `ctx.lower` takes the option but does not inherit this
   * call's value.
   */
  stripTypes?: boolean;
  /**
   * A sink for core's warnings: they are pushed here as they are raised, so
   * those raised before a later error stay in the caller's array.
   * `diagnostics` still reports this call's warnings (not entries already in
   * the array) when the source lowers.
   */
  warnings?: MxWarning[];
}

/** @unstable */
export interface LowerSourceResult {
  /**
   * Absent when `diagnostics` holds an error: no partial IR. A private copy,
   * spans guaranteed (`SpannedIr`); `DelegatedTag.args` is always present
   * (`[]` without arguments).
   */
  ir: SpannedIr | undefined;
  diagnostics: IrDiagnostic[];
}

const lookups = new WeakMap<HostDeclarations, TargetLookup>();

/**
 * The target lookup `compileSource` requires. Core reads two facts from it:
 * which packages export `AttrTag` (this one: core) and a host's module
 * segment (none). One lookup per declarations object.
 */
function lookupFor(declarations: HostDeclarations): TargetLookup {
  let lookup = lookups.get(declarations);
  if (!lookup) {
    lookup = createTargetLookup([
      {
        descriptorVersion: 0,
        name: "ir",
        packageName: "@mxlang/core",
        defaultTag: DEFAULT_TAG,
        declarations: { default: declarations },
      },
    ]);
    lookups.set(declarations, lookup);
  }
  return lookup;
}

/** The names `unknownTags: "reject"` accepts: the built-in `object`, then every `customTags` key. */
function declaredTagNames(
  customTags: Record<string, CustomTag> | undefined,
): Set<string> {
  return new Set([...builtinTagNames(), ...Object.keys(customTags ?? {})]);
}

/**
 * The preset `filename` parses under: the call's `tagRules`, else its
 * dialect's (decision 212 item 8). A dialect that fails to resolve throws
 * the error the compile would raise.
 */
function presetOf(
  options: LowerSourceOptions,
  dialectOnce: () => ReturnType<typeof dialectOf>,
): TagRulesPreset {
  if (options.tagRules !== undefined) return options.tagRules;
  const dialect = dialectOnce();
  return dialect ? dialectTagRules(dialect) : "html";
}

/** The three lowering options after the call's, the dialect's and the defaults. */
interface LowerModes {
  readonly structural: "pass" | "reject";
  readonly imports: "pass" | "reject";
  readonly unknownTags: "allow" | "reject";
}

/**
 * Each option as the call states it, else as the file's dialect does, else
 * its default; `imports` defaults to the effective `structural`. A dialect
 * that fails to resolve states nothing: the compile reports why.
 */
function modesOf(
  options: LowerSourceOptions,
  dialectOnce: () => ReturnType<typeof dialectOf>,
): LowerModes {
  let dialect: ReturnType<typeof dialectOf>;
  try {
    dialect = dialectOnce();
  } catch {
    dialect = undefined;
  }
  const structural = options.structural ?? dialect?.structural ?? "pass";
  return {
    structural,
    imports: options.imports ?? dialect?.imports ?? structural,
    unknownTags: options.unknownTags ?? dialect?.unknownTags ?? "allow",
  };
}

/** The dialect `filename` compiles under; throws as the compile would. */
function dialectOf(options: LowerSourceOptions, filename: string) {
  return (
    options.dialect !== undefined
      ? explicitSyntaxOf(options.dialect, filename)
      : resolveSyntaxOf(filename)
  ).dialect;
}

/** The id of the file's dialect, or `undefined` when it has none (or cannot be resolved). */
function dialectIdOf(
  dialectOnce: () => ReturnType<typeof dialectOf>,
): string | undefined {
  try {
    return dialectOnce()?.id;
  } catch {
    return undefined;
  }
}

/** A `customTags` definition that names a reserved tag, with why. */
interface RefusedDefinition {
  name: string;
  message: string;
}

/**
 * The `customTags` entries that name a reserved tag: core's structural
 * names for every caller, and the `reservedTags` of the dialect the file
 * routes to, unless the call passes a `dialect` (that caller is the
 * dialect's own front end, so its definitions are the dialect's). Never
 * throws: a routing failure is the compile's to report.
 */
function reservedDefinitions(
  options: LowerSourceOptions,
  filename: string,
): RefusedDefinition[] {
  const refused: RefusedDefinition[] = [];
  const names = Object.keys(options.customTags ?? {});
  if (names.length === 0) return refused;
  const discovery =
    options.dialect !== undefined
      ? CORE_TAG_DISCOVERY
      : callerTagDiscovery(filename);
  for (const name of names) {
    const message = reservedRefusal(name, discovery, "`customTags`");
    if (message !== undefined) refused.push({ name, message });
  }
  return refused;
}

/** `options.customTags` without the refused definitions. */
function without(
  options: LowerSourceOptions,
  refused: readonly RefusedDefinition[],
): Record<string, CustomTag> {
  const dropped = new Set(refused.map((definition) => definition.name));
  const kept: Record<string, CustomTag> = Object.create(null);
  for (const name of Object.keys(options.customTags ?? {})) {
    if (!dropped.has(name))
      kept[name] = (options.customTags as Record<string, CustomTag>)[
        name
      ] as CustomTag;
  }
  return kept;
}

/** One authored call of a refused name, as the authored-tag scan finds it. */
type ReservedCall = NonNullable<ReturnType<typeof scanAuthoredTags>>[number];

/**
 * Every call of a refused name in the source, in document order. Empty when
 * the source does not parse, so no call can be found.
 */
function reservedCalls(
  refused: readonly RefusedDefinition[],
  source: string,
  filename: string,
  rules: ReturnType<typeof tagRulesPreset> | undefined,
  customTags: Record<string, CustomTag> | undefined,
  options: LowerSourceOptions,
): ReservedCall[] {
  if (!rules) return [];
  const names = new Set(refused.map((definition) => definition.name));
  try {
    const found = scanAuthoredTags(
      source,
      filename,
      rules,
      registrationView(customTags, claimedFields(dialectOf(options, filename))),
      options.defaultTag ?? DEFAULT_TAG,
      options.dialect,
      names,
    );
    // The scan reports every tag that is not core's; keep the refused ones.
    return (found ?? []).filter((call) => names.has(call.name));
  } catch {
    return [];
  }
}

/**
 * One `MX_RESERVED_TAG` error per call site of each refused name, or one at
 * the source's 1:0 when the name is never called.
 */
function reservedDiagnostics(
  refused: readonly RefusedDefinition[],
  calls: readonly ReservedCall[],
  source: string,
  filename: string,
  lineStarts: number[],
): IrDiagnostic[] {
  return refused.flatMap(({ name, message }) => {
    const sites = calls.filter((call) => call.name === name);
    return (sites.length > 0 ? sites : [{ line: 1, column: 0 }]).map((at) =>
      toDiagnostic(
        "error",
        message,
        {
          line: at.line,
          column: at.column,
          ...("nameEnd" in at && at.nameEnd ? { end: at.nameEnd } : {}),
        },
        RESERVED_TAG_CODE,
        lineStarts,
        source,
        filename,
      ),
    );
  });
}

/**
 * The file's dialect's unknown-tag explainer, or `undefined` when the dialect
 * has no `explainUnknownTag` (or cannot be resolved: the compile reports that).
 */
function explainerOf(
  modes: LowerModes,
  dialectOnce: () => ReturnType<typeof dialectOf>,
  customTags: LowerSourceOptions["customTags"],
  filename: string,
  source: string,
  lineStarts: number[],
): Explainer | undefined {
  try {
    const dialect = dialectOnce();
    if (!dialect?.explainUnknownTag) return undefined;
    const claimed = claimedFields(dialect);
    return explainerFor(dialect, {
      mode: modes.unknownTags,
      file: filename,
      source,
      lineStarts,
      env: {
        customTags: registrationView(customTags, claimed),
        tagFields: claimed.tag,
        memo: new WeakMap(),
      },
    });
  } catch {
    return undefined;
  }
}

/**
 * Parses, lowers and checks one source, returning its IR.
 *
 * Never throws: every error the source has is a positioned error diagnostic
 * (see the file header for which are collected together).
 *
 * @unstable
 */
export function lowerSource(
  source: string,
  filename: string,
  options: LowerSourceOptions = {},
): LowerSourceResult {
  // The file's dialect, resolved at most once per call (routing costs a stat
  // pass): a throw is not kept, so the compile still reports it.
  let resolved: { dialect: ReturnType<typeof dialectOf> } | undefined;
  const dialectOnce = () => {
    resolved ??= { dialect: dialectOf(options, filename) };
    return resolved.dialect;
  };
  const result = lowerResolved(source, filename, options, dialectOnce);
  // The one place the dialect's `diagnosticCodes` apply: to the final list
  // of every exit, after it is ordered (ordering keys on core codes).
  let map: Readonly<Record<string, string>> | undefined;
  try {
    map = dialectOnce()?.diagnosticCodes;
  } catch {
    // A dialect that does not resolve has no map; the diagnostics say why.
  }
  if (map === undefined) return result;
  return {
    ...result,
    diagnostics: [...renameDiagnosticCodes(result.diagnostics, map)],
  };
}

function lowerResolved(
  source: string,
  filename: string,
  options: LowerSourceOptions,
  dialectOnce: () => ReturnType<typeof dialectOf>,
): LowerSourceResult {
  const lineStarts = lineStartsOf(source);
  const warnings: MxWarning[] = options.warnings ?? [];
  const firstWarning = warnings.length;
  const refused = reservedDefinitions(options, filename);
  // A refused definition is dropped: everything below lowers as if the
  // caller had not passed it, and `refuse` then adds its diagnostics.
  let customTags =
    refused.length > 0 ? without(options, refused) : options.customTags;
  const refusedNames = new Set(refused.map((definition) => definition.name));
  let rules: ReturnType<typeof tagRulesPreset> | undefined;
  let calls: readonly ReservedCall[] | undefined;
  // Found once, after `rules` is known, and only when a definition was refused.
  const callsOfRefused = (): readonly ReservedCall[] => {
    calls ??= reservedCalls(
      refused,
      source,
      filename,
      rules,
      customTags,
      options,
    );
    return calls;
  };
  const refuse = (result: LowerSourceResult): LowerSourceResult => {
    if (refused.length === 0) return result;
    return {
      ir: undefined,
      diagnostics: mergeDiagnostics(
        result.ir ? [] : result.diagnostics,
        reservedDiagnostics(
          refused,
          callsOfRefused(),
          source,
          filename,
          lineStarts,
        ),
      ),
    };
  };
  // A call of a refused name already has its `MX_RESERVED_TAG`, which is the
  // cause: a closed parent's `MX_TAG_NOT_ALLOWED` about that same occurrence
  // (name and offset, as the lowering recorded it) is dropped.
  const withoutRefusedOccurrences = (errors: unknown[]): unknown[] => {
    if (refused.length === 0) return errors;
    const at = new Set(
      callsOfRefused().map((call) => `${call.offset}:${call.name}`),
    );
    return errors.flatMap(flattenErrors).filter((entry) => {
      const occurrence = tagOccurrenceOf(entry);
      if (occurrence === undefined) return true;
      const file = (entry as TranslateError).file;
      if (file !== undefined && file !== filename) return true;
      return !at.has(`${occurrence.offset}:${occurrence.name}`);
    });
  };
  const failed = (errors: unknown[]): LowerSourceResult =>
    refuse({
      ir: undefined,
      diagnostics: errorDiagnostics(
        withoutRefusedOccurrences(errors),
        filename,
        lineStarts,
        source,
      ),
    });
  try {
    rules = tagRulesPreset(presetOf(options, dialectOnce), WEB_ELEMENTS);
  } catch (error) {
    return failed([error]);
  }
  // The dialect's `contracts` under the caller's (or the scan's) definitions,
  // with its reserved ones on top; a dialect that fails to resolve is the
  // compile's to report.
  try {
    customTags = dialectCustomTags(
      customTags,
      dialectOnce(),
      options.dialect !== undefined,
    );
  } catch {
    // The compile below resolves the dialect again and reports the failure.
  }
  const modes = modesOf(options, dialectOnce);
  const declarations = entryDeclarations(rules.nativeTags);
  const declared = declaredTagNames(customTags);
  const dialectId = dialectIdOf(dialectOnce);
  let ir: Ir | null = null;
  try {
    const host: HostOptions = {
      targets: lookupFor(declarations),
      taglibs: taglibsOfRules(rules),
      statementTags: false,
      customTags,
      defaultTag: options.defaultTag,
      ...(options.stripTypes !== undefined
        ? { stripTypes: options.stripTypes }
        : {}),
      ...(options.dialect !== undefined ? { dialect: options.dialect } : {}),
      warnings,
      emitIr: (lowered) => {
        ir = lowered;
        // The IR, not a module, is the output; `compileSource` requires text
        // back, so the emitted "code" is an unused placeholder.
        return "";
      },
    };
    // `rules` is already this file's preset (`presetOf`): the call's
    // `tagRules` wins over the dialect's, so the compile must not re-pick.
    tagRulesDecided.set(host, presetOf(options, dialectOnce));
    compileSource(source, filename, declarations, host);
  } catch (error) {
    const reject = modes.unknownTags === "reject";
    const explainer = explainerOf(
      modes,
      dialectOnce,
      customTags,
      filename,
      source,
      lineStarts,
    );
    if (!reject && !explainer) return failed([error]);
    try {
      // A deferred entry's contract answers from its view (never throws):
      // its call already reported why it cannot be read.
      const tags = scanAuthoredTags(
        source,
        filename,
        rules,
        registrationView(customTags, claimedFields(dialectOnce())),
        options.defaultTag ?? DEFAULT_TAG,
        options.dialect,
        undefined,
        explainer && {
          explainer,
          // A call of a refused name has its own error: the dialect is not asked.
          declared: new Set([...declared, ...refusedNames]),
        },
      );
      // A refused name's call already has its `MX_RESERVED_TAG`: one
      // diagnostic per occurrence, so it is not also unknown.
      const unknown = (tags ?? []).filter(
        (tag) => !declared.has(tag.name) && !refusedNames.has(tag.name),
      );
      // Allow mode only has what the dialect explained to say.
      const reported = reject
        ? unknown
        : unknown.filter((tag) => tag.explained);
      if (reported.length === 0) return failed([error]);
      // An unknown tag inside a closed parent got `MX_TAG_NOT_ALLOWED` from
      // the lowering and, from the scan, `MX_UNKNOWN_TAG` or the dialect's
      // explanation: one tag, two errors. The unknown tag is the cause, so the
      // not-allowed error about the same occurrence is dropped. The occurrence
      // is what the lowering recorded when it raised the error (name and
      // offset, in this file), never the message text. What the dropped message
      // said beyond "not allowed" (a wildcard rule, a hint) moves onto the
      // surviving core error; a dialect's explanation is its own words and
      // keeps them.
      const lowering = flattenErrors(error);
      const reportedAt = new Map(
        reported.map((tag) => [`${tag.offset}:${tag.name}`, tag]),
      );
      const guidance = new Map<string, string>();
      const kept = lowering.filter((entry) => {
        const occurrence = tagOccurrenceOf(entry);
        if (occurrence === undefined) return true;
        // An error about another file's tag (a template tag file's contract)
        // can share a name and offset with this file's: it is not this one.
        const file = (entry as TranslateError).file;
        if (file !== undefined && file !== filename) return true;
        const key = `${occurrence.offset}:${occurrence.name}`;
        if (!reportedAt.has(key)) return true;
        if (occurrence.guidance) guidance.set(key, occurrence.guidance);
        return false;
      });
      const errors = reported.map((tag) => {
        if (tag.explained) return tag.explained;
        const extra = guidance.get(`${tag.offset}:${tag.name}`);
        const unknownError = codedError(
          UNKNOWN_TAG_CODE,
          unknownTagMessage(tag.name, declared, dialectId) +
            (extra ? `; ${extra}` : ""),
          tag.line,
          tag.column,
        );
        if (tag.nameEnd) unknownError.end = tag.nameEnd;
        return unknownError;
      });
      const ranges = reported.map((tag) => ({
        name: tag.name,
        at: { line: tag.line, column: tag.column },
        ...(tag.endLine !== undefined && tag.endColumn !== undefined
          ? { end: { line: tag.endLine, column: tag.endColumn } }
          : {}),
      }));
      const explained = new Set<unknown>(
        reported.flatMap((tag) => (tag.explained ? [tag.explained] : [])),
      );
      return failed(
        labelInside(
          [...kept.map(withoutCollected), ...errors],
          ranges,
          explained,
        ),
      );
    } catch (scanError) {
      return failed([error, scanError]);
    }
  }
  if (!ir) {
    return failed([
      new Error("@mxlang/core: lowerSource produced no IR and no error"),
    ]);
  }
  const lowered = ir as Ir;
  // Never throws: the check records every error, even one outside its
  // recovery points, and returns them with the rest.
  const successExplainer = explainerOf(
    modes,
    dialectOnce,
    customTags,
    filename,
    source,
    lineStarts,
  );
  const errors = checkIr(lowered, source, {
    ...modes,
    declaredTags: declared,
    ...(dialectId !== undefined ? { dialectId } : {}),
    exemptTags: refusedNames,
    ...(successExplainer ? { explainer: successExplainer } : {}),
  });
  if (errors.length > 0) return failed(errors);
  let finished: SpannedIr;
  try {
    finished = finishIr(lowered, source);
  } catch (error) {
    return failed([error]);
  }
  return refuse({
    ir: finished,
    diagnostics: warnings
      .slice(firstWarning)
      .map((warning) =>
        toDiagnostic(
          "warning",
          warning.message,
          warning,
          warning.code,
          lineStarts,
          source,
          filename,
        ),
      ),
  });
}

/**
 * `lowerSource` over a file on disk. Reading the file is the caller's
 * concern: a file that cannot be read throws, as `readFileSync` does.
 *
 * @unstable
 */
export function lowerFile(
  path: string,
  options: LowerSourceOptions = {},
): LowerSourceResult {
  return lowerSource(readFileSync(path, "utf8"), path, options);
}
