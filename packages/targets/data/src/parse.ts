/**
 * `@mxlang/data` — the data target's public API (decisions 131/132).
 *
 * `parseData` compiles a `.mx` source with the data declarations and the
 * data taglib and projects the IR into the static tree (`tree.ts`). It fails
 * fast: Marko's parser and core's `fail` both stop at the first error, so an
 * error means exactly one positioned diagnostic and `tree: undefined` — no
 * partial tree in v1 (the 131 addendum's item 8). Warnings (a duplicate
 * attribute, today) are collected and returned alongside the tree.
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
} from "@mxlang/core";
import { buildDataDocument, lineStartsOf, unknownTagMessage } from "./build.ts";
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
   * `package.json#mx.data.defaultTag`, already validated: what the unnamed
   * tag (`<#id>`, `<.class>`) stands for in place of the built-in `object`
   * (decision 145).
   */
  defaultTag?: string;
  /**
   * `"pass"` (default) keeps the structural constructs — text, `${}`,
   * `<if>`/`<for>`/`<const>`, comments, `import`/`export`/`static` — in the
   * tree for the consumer to interpret. `"reject"` makes each one a
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
   * body text, which `structural: "reject"` rejects. `"reject"` with
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

/**
 * The unknown authored tag that a core error must yield to, if any.
 *
 * Core raises a contract error (`parents`/`children`) during compile and
 * stops at the first, so an unknown parent's own typo would be hidden behind
 * its child's error. Under `unknownTags: "reject"` the unknown-tag check
 * comes first in document order: scan the authored tags with a parse-only
 * pass (`scan.ts`, no lowering, so a later lowering error cannot interfere)
 * and return the earliest unknown one (by position) when it opens strictly before the core
 * error. An ancestor of the failing tag always does. When the source does not
 * parse there is nothing to list and the original error stands.
 * On this path the build never runs, so an unknown tag wins a tie with a build
 * error at the same position.
 */
function unknownTagBefore(
  error: DataDiagnostic,
  source: string,
  filename: string,
  options: ParseDataOptions,
): { message: string; at: { line: number; column: number } } | null {
  if (error.file !== undefined && error.file !== filename) return null;
  const tags = scanAuthoredTags(
    source,
    filename,
    options.customTags,
    options.defaultTag,
  );
  if (!tags) return null;
  const declared = declaredTagNames(options.customTags);
  // The earliest by position, not the first in the scan's walk order (which
  // visits a tag's attribute tags before its children).
  let unknown: (typeof tags)[number] | undefined;
  for (const tag of tags) {
    if (declared.has(tag.name)) continue;
    if (
      !unknown ||
      tag.line < unknown.line ||
      (tag.line === unknown.line && tag.column < unknown.column)
    ) {
      unknown = tag;
    }
  }
  if (!unknown) return null;
  const { line, column } = unknown;
  const before =
    line < error.line || (line === error.line && column < error.column);
  return before
    ? { message: unknownTagMessage(unknown.name, declared), at: unknown }
    : null;
}

/**
 * Parses one data source into its static tree.
 *
 * Never throws for a source-level problem: a parse error, a rejected
 * construct or a failed contract is the single error diagnostic. An error
 * with no position at all is an internal failure, not source feedback, and
 * is rethrown.
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
  // so `compileSource` raises and `toErrorDiagnostic` reports it like any
  // other core error. This target adds no rule of its own for them, and needs
  // none — a construct core drops is a core bug, not a data one.
  const toErrorDiagnostic = (error: unknown): DataDiagnostic | null => {
    const at = errorPosition(error);
    if (!at) return null;
    return toDiagnostic(
      "error",
      errorMessage(error, filename),
      at,
      lineStarts,
      source,
      filename,
    );
  };
  try {
    compileSource(source, filename, dataDeclarations, {
      targets: dataTargets,
      taglibs: [dataTaglib()],
      tagDiscoveryDirs: [],
      customTags: options.customTags,
      defaultTag: options.defaultTag,
      warnings,
      emitIr: (lowered) => {
        ir = lowered;
        // The tree, not a module, is this target's output; `compileSource`
        // requires text back, so the emitted "code" is an unused placeholder.
        return "";
      },
    });
  } catch (error) {
    const diagnostic = toErrorDiagnostic(error);
    if (!diagnostic) throw error;
    const unknown =
      options.unknownTags === "reject"
        ? unknownTagBefore(diagnostic, source, filename, options)
        : null;
    return {
      tree: undefined,
      diagnostics: [
        unknown
          ? toDiagnostic(
              "error",
              unknown.message,
              unknown.at,
              lineStarts,
              source,
              filename,
            )
          : diagnostic,
      ],
    };
  }
  if (!ir) {
    throw new Error("@mxlang/data: compile produced no IR and no error");
  }
  const document = ir as Ir;
  try {
    const tree = buildDataDocument(document, source, filename, {
      structural: options.structural ?? "pass",
      imports: options.imports ?? options.structural ?? "pass",
      unknownTags: options.unknownTags ?? "allow",
      declaredTags: declaredTagNames(options.customTags),
    });
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
  } catch (error) {
    const diagnostic = toErrorDiagnostic(error);
    if (!diagnostic) throw error;
    return { tree: undefined, diagnostics: [diagnostic] };
  }
}

/** `parseData` over a file on disk. */
export function parseDataFile(
  path: string,
  options: ParseDataOptions = {},
): ParseDataResult {
  return parseData(readFileSync(path, "utf8"), path, options);
}
