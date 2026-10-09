/**
 * `@mxlang/data` — the data target's public API (decisions 131/132).
 *
 * `parseData` compiles a `.mx` source with the data declarations and the
 * data taglib and projects the IR into the static tree (`tree.ts`). An error
 * means `tree: undefined` — no partial tree in v1 (the 131 addendum's item 8) —
 * and every independent error the file has, each positioned, earliest first:
 * all of Marko's parse errors (its parser recovers and reports several), and,
 * once the file lowers, every build reject, structural hit and unknown tag.
 * Core's lowering stops at its first error by design, so a lowering error
 * (`parents`/`children`, a bad attribute) is the one error of its kind; under
 * `unknownTags: "reject"` the file's unknown tags are still listed beside it.
 * No input makes `parseData` throw: an error with no position (a bug in this
 * package or core) is reported at 1:0 with an `internal error:` message prefix, and
 * a user-facing one that has none (a Marko taglib error) with `unpositioned error:`.
 * Warnings (a duplicate attribute, today) are collected and returned alongside
 * the tree.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type CustomTag,
  compileSource,
  createTargetLookup,
  type Ir,
  isTranslateError,
  type MxWarning,
  type SyntaxTable,
  TranslateError,
} from "@mxlang/core";
import {
  buildDataDocumentAll,
  labelInside,
  lineStartsOf,
  type UnknownTagRange,
  unknownTagMessage,
} from "./build.ts";
import { dataDeclarations } from "./declarations.ts";
import { scanAuthoredTags } from "./scan.ts";
import { dataTaglib } from "./taglib.ts";
import { dataTargetBase } from "./target-base.ts";
import type { DataDocument } from "./tree.ts";

export type { Atom, MxAtomMark } from "@mxlang/core";
export { serializeDataDocument } from "./compile.ts";
export { dataDeclarations, RESERVED_NAMES } from "./declarations.ts";
export { DATA_TAGLIB_ID, dataTaglib, neutralizations } from "./taglib.ts";
export type {
  DataAttr,
  DataAttrTag,
  DataAttrTagNode,
  DataBranch,
  DataDocument,
  DataExpr,
  DataForHead,
  DataImport,
  DataNode,
  DataStatement,
  DataTag,
  SerializedDataDocument,
} from "./tree.ts";

const dataTargets = createTargetLookup([dataTargetBase]);

export interface ParseDataOptions {
  /** Contract-only custom tags (decision 130), by call name. */
  customTags?: Record<string, CustomTag>;
  /**
   * The syntax table (decision 182), for a consumer that builds its own
   * (Mesh); omitted, the file's nearest `package.json#mx.syntax`. Until core
   * lowers triggers, a trigger, block tag or filter the table produces is a
   * positioned diagnostic ("`<id>` trigger has no lowering yet").
   */
  syntax?: SyntaxTable;
  /**
   * `package.json#mx.data.defaultTag`, already validated: what the unnamed
   * tag (`<#id>`, `<.class>`) stands for in place of the built-in `object`
   * (decision 145).
   */
  defaultTag?: string;
  /**
   * `"pass"` (default) keeps the structural constructs — text, `${}`,
   * `<if>`/`<for>`/`<const>`, `import`/`export`/`static` — in the
   * tree for the consumer to interpret. Comments are never structural:
   * under either value a `//` line or `<!-- -->` stays in the tree as the
   * `Comment` node it already is under `"pass"` (decision 131 addendum 5).
   * `"reject"` makes each structural construct a
   * positioned error ("the data tree is static; this file's consumer does
   * not evaluate `<if>`"), for a consumer that wants tags and attributes
   * only and must not silently ignore an `<if>` its codegen never reads.
   * A structural hit and a build error (a dynamic tag, a doctype) are
   * ordered by position: the one earlier in the file is reported. Before,
   * the structural hit always won.
   */
  structural?: "pass" | "reject";
  /**
   * Whether a top-level `import` passes. Defaults to the effective
   * `structural` value, so nothing changes unless it is set. `"pass"` with
   * `structural: "reject"` keeps control flow, `export` and `static`
   * rejected and returns the imports verbatim as `tree.imports` (file order,
   * UTF-16 spans). A tag-body `import` is not an import: Marko parses it as
   * body text, which `structural: "reject"` rejects as text. `"reject"` with
   * `structural: "pass"` rejects only the `import`s.
   */
  imports?: "pass" | "reject";
  /**
   * `"allow"` (default) keeps the open set of decision 131: a tag with no
   * entry in `customTags` is accepted. `"reject"` closes it: any tag, at any
   * depth, whose name has no entry in `customTags` is a positioned error
   * naming the tag, with a nearest-declared-name hint when one is close. A
   * dialect that declares every tag uses it so a typo at the top level
   * cannot pass silently. Placement at `#root` stays the job of `parents`;
   * the reserved names never reach the check (core consumes them first). The
   * check runs on a tag before anything inside it, in document order: an
   * unknown parent is reported before its children's `parents`/`children`
   * errors, and the earliest position wins against a `structural: "reject"`
   * hit or a build error. A known parent's `children` error positioned at
   * the unknown tag itself still wins.
   */
  unknownTags?: "allow" | "reject";
  /**
   * A sink for core's warnings, as on the other targets: they are pushed here
   * as they are raised, so those raised before a later error stay in the
   * caller's array. `diagnostics` still reports this call's warnings (not
   * entries already in the array) when the parse succeeds.
   */
  warnings?: MxWarning[];
}

export interface DataDiagnostic {
  severity: "error" | "warning";
  message: string;
  /**
   * 1-based, as `TranslateError` and `MxWarning`. An error or warning with no
   * source position (core's 0:0, as for a bad `customTags` registration) is
   * file-level: `line: 1`, `column: 0`, `offset: 0` (`-1` when `file` names
   * another file).
   */
  line: number;
  /** 0-based, as core. */
  column: number;
  /**
   * UTF-16 code-unit offset, derived from `line`/`column` so a consumer
   * needs no line table. `-1` when `file` names another file: that file's
   * text is not available to `parseData`, so no offset can be computed.
   */
  offset: number;
  /** When the diagnostic's position is measured in another file. */
  file?: string;
}

export interface ParseDataResult {
  /** Absent when `diagnostics` holds an error: no partial tree. */
  tree: DataDocument | undefined;
  diagnostics: DataDiagnostic[];
}

function offsetOf(
  lineStarts: number[],
  source: string,
  line: number,
  column: number,
): number {
  const start = lineStarts[line - 1];
  if (start === undefined) return source.length;
  return Math.min(start + column, source.length);
}

/** The position an error carries, in the shape core and Marko each report. */
function errorPosition(
  error: unknown,
): { line: number; column: number; file?: string } | null {
  if (isTranslateError(error)) {
    return { line: error.line, column: error.column, file: error.file };
  }
  if (!error || typeof error !== "object") return null;
  const loc = (error as { loc?: unknown }).loc;
  if (!loc || typeof loc !== "object") return null;
  const direct = loc as { line?: unknown; column?: unknown };
  if (typeof direct.line === "number" && typeof direct.column === "number") {
    return { line: direct.line, column: direct.column };
  }
  const start = (loc as { start?: unknown }).start;
  if (!start || typeof start !== "object") return null;
  const nested = start as { line?: unknown; column?: unknown };
  if (typeof nested.line === "number" && typeof nested.column === "number") {
    return { line: nested.line, column: nested.column };
  }
  return null;
}

/**
 * The prefixes Babel may have put in front of a lowering error's message.
 *
 * The wrap in `@marko/compiler`'s Babel pass prepends `` `${opts.filename}: ` ``,
 * and Babel resolves `opts.filename` against its `cwd` before the wrap runs
 * — so a relative or `./` filename is prefixed by its **absolute** form and
 * the caller's own spelling never matches. Strip whichever of the two leads,
 * longest first so `/a/t.mx: ` wins over `t.mx: `.
 */
function pathPrefixes(filename: string): string[] {
  const names = new Set<string>([filename, resolve(filename)]);
  return [...names]
    .map((name) => `${name}: `)
    .sort((a, b) => b.length - a.length);
}

/**
 * The message an error carries. Marko's `CompileError` (a syntax error) has
 * a one-line `label` ("EOF reached while parsing open tag") and a multi-line
 * framed `message`; the label is the diagnostic text. Everything else uses
 * `message` as is — after stripping the `filename: ` prefix the Babel pass
 * inside `@marko/compiler` prepends to any error thrown while lowering
 * (`babel.js`'s error wrap), which belongs to the diagnostic's `file` field,
 * not its text.
 */
function errorMessage(error: unknown, filename: string): string {
  const prefixes = pathPrefixes(filename);
  const strip = (text: string) => {
    for (const prefix of prefixes) {
      if (text.startsWith(prefix)) return text.slice(prefix.length);
    }
    return text;
  };
  if (error instanceof Error) {
    const label = (error as { label?: unknown }).label;
    if (typeof label === "string" && label.length > 0) return strip(label);
    return strip(error.message);
  }
  return String(error);
}

function toDiagnostic(
  severity: "error" | "warning",
  message: string,
  at: { line: number; column: number; file?: string },
  lineStarts: number[],
  source: string,
  filename: string,
): DataDiagnostic {
  const foreign = at.file !== undefined && at.file !== filename;
  // Core reports a registration error, and may report a warning, with no
  // source position at 0:0 (or a non-positive line). That is file-level:
  // report it at the start of the file so `line` stays 1-based. `at` is the
  // caller's object (a warning sink entry): read it, never write to it.
  const [line, column] = at.line < 1 ? [1, 0] : [at.line, at.column];
  return {
    severity,
    message,
    line,
    column,
    offset: foreign ? -1 : offsetOf(lineStarts, source, line, column),
    ...(at.file !== undefined ? { file: at.file } : {}),
  };
}

/** The names `unknownTags: "reject"` accepts: the declared built-ins (`object`), then every `customTags` key. */
function declaredTagNames(
  customTags: Record<string, CustomTag> | undefined,
): Set<string> {
  return new Set([
    ...(dataDeclarations.builtinTags ?? []),
    ...Object.keys(customTags ?? {}),
  ]);
}

/** The prefix of a diagnostic for a bug (ours or core's) with no source position. */
const INTERNAL_PREFIX = "internal error: ";

/**
 * The prefix of a diagnostic for a user-facing error that carries no source
 * position: a Marko `CompileError` (it has a `label`) about the taglib or the
 * config rather than a syntax error. It is not a bug, so it is not "internal".
 */
const UNPOSITIONED_PREFIX = "unpositioned error: ";

function isUnpositionedPrefix(message: string): boolean {
  return (
    message.startsWith(INTERNAL_PREFIX) ||
    message.startsWith(UNPOSITIONED_PREFIX)
  );
}

/** The prefix for an error with no position: user-facing (a Marko label) or a bug. */
function noPositionPrefix(error: unknown): string {
  const label = (error as { label?: unknown } | null)?.label;
  return error instanceof Error && typeof label === "string" && label.length > 0
    ? UNPOSITIONED_PREFIX
    : INTERNAL_PREFIX;
}

/**
 * The errors one thrown value stands for. `@marko/compiler` throws a
 * `CompileErrors` aggregate (an `errors` array of positioned `CompileError`s,
 * no position of its own) when its parser recovered from several syntax
 * errors; every one of them is a diagnostic.
 */
function flattenErrors(error: unknown): unknown[] {
  // Core's own list (decision 162) holds the thrown error as its first entry,
  // so it is read here, not recursed into.
  if (isTranslateError(error)) return [...(error.errors ?? [error])];
  const inner = (error as { errors?: unknown } | null)?.errors;
  return Array.isArray(inner) && inner.length > 0
    ? inner.flatMap(flattenErrors)
    : [error];
}

/**
 * One diagnostic per error, earliest first, the same message at the same place
 * once. An error with no position is not source feedback but a bug here or in
 * core: it is still reported, at the file start, under {@link INTERNAL_PREFIX}
 * so a consumer can tell it from the author's mistake.
 */
function errorDiagnostics(
  errors: unknown[],
  filename: string,
  lineStarts: number[],
  source: string,
): DataDiagnostic[] {
  const out: DataDiagnostic[] = [];
  const seen = new Set<string>();
  for (const error of errors.flatMap(flattenErrors)) {
    const at = errorPosition(error);
    const message = errorMessage(error, filename);
    const diagnostic = toDiagnostic(
      "error",
      at ? message : `${noPositionPrefix(error)}${message}`,
      at ?? { line: 1, column: 0 },
      lineStarts,
      source,
      filename,
    );
    const key = `${diagnostic.file ?? ""}:${diagnostic.line}:${diagnostic.column}:${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diagnostic);
  }
  // Stable: errors at one position keep the order they were found in; the
  // unpositioned ones (at 1:0) stay after every positioned error.
  const rank = (d: DataDiagnostic) => (isUnpositionedPrefix(d.message) ? 1 : 0);
  return out
    .map((d, i) => ({ d, i }))
    .sort(
      (a, b) =>
        rank(a.d) - rank(b.d) ||
        (a.d.file ?? "").localeCompare(b.d.file ?? "") ||
        a.d.line - b.d.line ||
        a.d.column - b.d.column ||
        a.i - b.i,
    )
    .map(({ d }) => d);
}

/**
 * Every authored tag with no contract in `customTags`, as errors.
 *
 * Core reports every tag's error but a tag with no contract is not one core
 * raises, so a contract error (`parents`/`children`) would hide an unknown tag
 * elsewhere in the file. Under
 * `unknownTags: "reject"` the unknown tags are listed from a parse-only pass
 * (`scan.ts`: the MX front end's parse, no lowering, so a later lowering
 * error cannot interfere) and
 * reported beside core's error. When the source does not parse there is
 * nothing to list.
 */
function unknownTagErrors(
  source: string,
  filename: string,
  options: ParseDataOptions,
): { errors: TranslateError[]; ranges: UnknownTagRange[] } {
  const tags = scanAuthoredTags(
    source,
    filename,
    options.customTags,
    options.defaultTag,
    options.syntax,
  );
  if (!tags) return { errors: [], ranges: [] };
  const declared = declaredTagNames(options.customTags);
  const unknown = tags.filter((tag) => !declared.has(tag.name));
  return {
    errors: unknown.map(
      (tag) =>
        new TranslateError(
          unknownTagMessage(tag.name, declared),
          tag.line,
          tag.column,
        ),
    ),
    ranges: unknown.map((tag) => ({
      name: tag.name,
      at: { line: tag.line, column: tag.column },
      ...(tag.endLine !== undefined && tag.endColumn !== undefined
        ? { end: { line: tag.endLine, column: tag.endColumn } }
        : {}),
    })),
  };
}

/**
 * Parses one data source into its static tree.
 *
 * Never throws: every error the file has is a positioned error diagnostic
 * (see the file header for which are collected together). An error with no
 * position is an internal failure, not source feedback: it is reported too,
 * at 1:0 under an `internal error:` prefix.
 */
export function parseData(
  source: string,
  filename: string,
  options: ParseDataOptions = {},
): ParseDataResult {
  const lineStarts = lineStartsOf(source);
  const warnings: MxWarning[] = options.warnings ?? [];
  const firstWarning = warnings.length;
  let ir: Ir | null = null;
  // No source pre-scan here any more: a CDATA section and an XML declaration
  // are rejected by core itself, at the `<` of the construct (decision 139),
  // so `compileSource` raises and the catch reports it like any other core
  // error. This target adds no rule of its own for them, and needs none — a
  // construct core drops is a core bug, not a data one.
  const failed = (errors: unknown[]): ParseDataResult => ({
    tree: undefined,
    diagnostics: errorDiagnostics(errors, filename, lineStarts, source),
  });
  try {
    compileSource(source, filename, dataDeclarations, {
      targets: dataTargets,
      taglibs: [dataTaglib()],
      statementTags: false,
      tagDiscoveryDirs: [],
      customTags: options.customTags,
      defaultTag: options.defaultTag,
      ...(options.syntax !== undefined ? { syntax: options.syntax } : {}),
      warnings,
      emitIr: (lowered) => {
        ir = lowered;
        // The tree, not a module, is this target's output; `compileSource`
        // requires text back, so the emitted "code" is an unused placeholder.
        return "";
      },
    });
  } catch (error) {
    if (options.unknownTags !== "reject") return failed([error]);
    try {
      const { errors, ranges } = unknownTagErrors(source, filename, options);
      return failed(labelInside([...flattenErrors(error), ...errors], ranges));
    } catch (scanError) {
      return failed([error, scanError]);
    }
  }
  if (!ir) {
    return failed([
      new Error("@mxlang/data: compile produced no IR and no error"),
    ]);
  }
  const document = ir as Ir;
  // Never throws: the build records every error, even one outside its recovery
  // points, and returns them with the rest.
  const built = buildDataDocumentAll(document, source, filename, {
    structural: options.structural ?? "pass",
    imports: options.imports ?? options.structural ?? "pass",
    unknownTags: options.unknownTags ?? "allow",
    declaredTags: declaredTagNames(options.customTags),
  });
  const { tree } = built;
  if (built.errors.length > 0 || !tree) {
    // A tree-less result always has errors; if that ever broke, an empty
    // `diagnostics` would read as success, so report the break itself.
    return failed(
      built.errors.length > 0
        ? built.errors
        : [new Error("@mxlang/data: build produced no tree and no error")],
    );
  }
  return {
    tree,
    diagnostics: warnings
      .slice(firstWarning)
      .map((warning) =>
        toDiagnostic(
          "warning",
          warning.message,
          warning,
          lineStarts,
          source,
          filename,
        ),
      ),
  };
}

/** `parseData` over a file on disk. */
export function parseDataFile(
  path: string,
  options: ParseDataOptions = {},
): ParseDataResult {
  return parseData(readFileSync(path, "utf8"), path, options);
}
