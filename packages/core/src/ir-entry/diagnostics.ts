/**
 * Errors and warnings to `IrDiagnostic`s, for the IR entry point
 * (`lowerSource`). Moved from `@mxlang/data`'s `parseData` with the same
 * positions, ordering, deduplication and prefixes.
 */

import { resolve } from "node:path";
import { isTranslateError } from "../core.ts";
import {
  EXPECTED_SINGLE_EXPRESSION_CODE,
  INTERNAL_ERROR_CODE,
  PARSE_EXPRESSION_CODE,
  type TemplateParseCode,
} from "../diagnostic-codes.ts";

/** The cascade of an open tag that never ended. */
const MISSING_END_TAG_CODE =
  "MX_PARSE_MISSING_END_TAG" satisfies TemplateParseCode;

/**
 * Where an {@link IrDiagnostic}'s range ends, measured in the same file as its
 * start. The end is exclusive. @unstable
 */
export interface IrDiagnosticEnd {
  /** 1-based, as `IrDiagnostic.line`. */
  line: number;
  /** 0-based, as `IrDiagnostic.column`. The first column after the range. */
  column: number;
  /**
   * UTF-16 code-unit offset in the same file as `IrDiagnostic.offset`: never
   * `-1` for a diagnostic in the lowered file, and `-1` exactly when `file`
   * names another file (as `IrDiagnostic.offset`).
   */
  offset: number;
}

/**
 * One text replacement of an {@link IrDiagnosticFix}: the UTF-16 code units
 * `offset` up to, and excluding, `end` become `newText`. An insertion has
 * `offset === end`. @unstable
 */
export interface IrDiagnosticEdit {
  /** UTF-16 code-unit offset of the first replaced unit. */
  offset: number;
  /** UTF-16 code-unit offset just past the last replaced unit (exclusive). */
  end: number;
  newText: string;
}

/**
 * A change that resolves a diagnostic, for a tool to offer as a quick fix.
 *
 * Every offset indexes the same file as the diagnostic's own `offset`: the
 * lowered file, or `file` when the diagnostic names another one. The edits of
 * one fix never overlap, so applying all of them (each against the original
 * text, last one first) yields the fixed source. @unstable
 */
export interface IrDiagnosticFix {
  /** What applying the fix does, in a few words: "Rename to `<script>`". */
  title: string;
  edits: readonly IrDiagnosticEdit[];
}

export interface IrDiagnostic {
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
   * text is not available here, so no offset can be computed.
   */
  offset: number;
  /**
   * The file the position is measured in, present only when that is another
   * file than the one lowered (a tag template's, a sidecar's, a manifest's).
   * Never the `filename` given to `lowerSource`, on any path.
   */
  file?: string;
  /**
   * A machine-readable code, when the diagnostic carries one: an error's
   * `TranslateError.diagnosticCode` (a dialect's `ctx.fail(message, { code })`)
   * or a warning's `MxWarning.code` (`MX_DUPLICATE_ATTRIBUTE`). @unstable
   */
  code?: string;
  /**
   * Where the range ends (exclusive), in the same file as the start. Absent
   * for a file-level diagnostic (no source position) and wherever core knows
   * no end. Equal to the start for a point error (a parse error at one
   * offset): a tool widens an empty range itself. A whole-tag error ends at
   * the end of `<name`, never at the element's close. @unstable
   */
  end?: IrDiagnosticEnd;
  /**
   * The changes that resolve the diagnostic, one fix per alternative, when
   * core knows them. Absent on nearly every diagnostic: a fix is offered only
   * where the repair is mechanical and unambiguous. Offsets are UTF-16
   * code-unit offsets in the same file as `offset`, `end` is exclusive and
   * the edits of one fix never overlap. @unstable
   */
  fixes?: readonly IrDiagnosticFix[];
}

/** The start offset of every line of `source`. */
export function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
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

/** What an error or warning says about where it is: a start, a file, an end. */
export interface ErrorPosition {
  line: number;
  column: number;
  file?: string;
  end?: { line: number; column: number };
  fixes?: readonly IrDiagnosticFix[];
}

/** The position an error carries, in the shape core and Marko each report. */
function errorPosition(error: unknown): ErrorPosition | null {
  if (isTranslateError(error)) {
    return {
      line: error.line,
      column: error.column,
      file: error.file,
      ...(error.end ? { end: error.end } : {}),
      ...(error.fixes ? { fixes: error.fixes } : {}),
    };
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
    // A parse error's range: Marko's point error shares one object between
    // `start` and `end`, so a point has an end equal to its start.
    const to = (loc as { end?: unknown }).end as
      | { line?: unknown; column?: unknown }
      | undefined;
    return {
      line: nested.line,
      column: nested.column,
      ...(typeof to?.line === "number" && typeof to?.column === "number"
        ? { end: { line: to.line, column: to.column } }
        : {}),
    };
  }
  return null;
}

/**
 * The prefixes a lowering error's message may carry: `` `${filename}: ` ``
 * as written or resolved against the working directory, longest first so
 * `/a/t.mx: ` wins over `t.mx: `.
 */
function pathPrefixes(filename: string): string[] {
  const names = new Set<string>([filename, resolve(filename)]);
  return [...names]
    .map((name) => `${name}: `)
    .sort((a, b) => b.length - a.length);
}

/**
 * The message an error carries. A `CompileError` (a syntax error) has a
 * one-line `label` ("EOF reached while parsing open tag") and a multi-line
 * framed `message`; the label is the diagnostic text. Everything else uses
 * `message` as is, after stripping a `filename: ` prefix, which belongs to
 * the diagnostic's `file` field, not its text.
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

export function toDiagnostic(
  severity: "error" | "warning",
  message: string,
  at: ErrorPosition,
  code: string | undefined,
  lineStarts: number[],
  source: string,
  filename: string,
): IrDiagnostic {
  // `file` names another file only: core sets it on some errors positioned
  // in the lowered file too (a dialect's, a table error's), so it is
  // dropped when it is `filename`, on every path (review 460 F8).
  const foreign =
    at.file !== undefined &&
    at.file !== filename &&
    resolve(at.file) !== resolve(filename);
  // Core reports a registration error, and may report a warning, with no
  // source position at 0:0 (or a non-positive line). That is file-level:
  // report it at the start of the file so `line` stays 1-based. `at` is the
  // caller's object (a warning sink entry): read it, never write to it.
  const [line, column] = at.line < 1 ? [1, 0] : [at.line, at.column];
  // A file-level diagnostic is not a range: it has no end. Otherwise the end
  // is measured in the same file as the start, with the same rules, and never
  // before it.
  const to = at.line < 1 ? undefined : at.end;
  const end =
    to === undefined
      ? undefined
      : to.line < line || (to.line === line && to.column < column)
        ? { line, column }
        : to;
  return {
    severity,
    message,
    line,
    column,
    offset: foreign ? -1 : offsetOf(lineStarts, source, line, column),
    ...(foreign ? { file: at.file } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(end
      ? {
          end: {
            line: end.line,
            column: end.column,
            offset: foreign
              ? -1
              : offsetOf(lineStarts, source, end.line, end.column),
          },
        }
      : {}),
    ...(at.fixes !== undefined && at.fixes.length > 0
      ? { fixes: at.fixes }
      : {}),
  };
}

/**
 * The stable code an error carries as `diagnosticCode`: a `TranslateError`'s,
 * or a parse error's (a `CompileError` with a non-enumerable one). Never a
 * Babel or system error's `code`, which is not ours.
 */
function diagnosticCodeOf(error: unknown): string | undefined {
  const code = (error as { diagnosticCode?: unknown } | null)?.diagnosticCode;
  return typeof code === "string" ? code : undefined;
}

/** The prefix of a diagnostic for a bug (ours or core's) with no source position. */
const INTERNAL_PREFIX = "internal error: ";

/**
 * The prefix of a diagnostic for a user-facing error that carries no source
 * position: a `CompileError` (it has a `label`) about the tag table or the
 * config rather than a syntax error. It is not a bug, so it is not "internal".
 */
const UNPOSITIONED_PREFIX = "unpositioned error: ";

function isUnpositionedPrefix(message: string): boolean {
  return (
    message.startsWith(INTERNAL_PREFIX) ||
    message.startsWith(UNPOSITIONED_PREFIX)
  );
}

/** The prefix for an error with no position: user-facing (a label) or a bug. */
function noPositionPrefix(error: unknown): string {
  const label = (error as { label?: unknown } | null)?.label;
  return error instanceof Error && typeof label === "string" && label.length > 0
    ? UNPOSITIONED_PREFIX
    : INTERNAL_PREFIX;
}

/**
 * The errors one thrown value stands for: core's own list (decision 162), or
 * a `CompileErrors` aggregate (an `errors` array of positioned
 * `CompileError`s, no position of its own) from a parse that recovered from
 * several syntax errors. Every one of them is a diagnostic.
 */
export function flattenErrors(error: unknown): unknown[] {
  // Core's list holds the thrown error as its first entry, so it is read
  // here, not recursed into.
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
export function errorDiagnostics(
  errors: unknown[],
  filename: string,
  lineStarts: number[],
  source: string,
): IrDiagnostic[] {
  const out: IrDiagnostic[] = [];
  const seen = new Set<string>();
  for (const error of errors.flatMap(flattenErrors)) {
    const at = errorPosition(error);
    const message = errorMessage(error, filename);
    const diagnostic = toDiagnostic(
      "error",
      at ? message : `${noPositionPrefix(error)}${message}`,
      at ?? { line: 1, column: 0 },
      // Only `diagnosticCode`, ours: a Babel or system error's `code` is not.
      // A `TranslateError` has one, and so does the `CompileError` a parse
      // error becomes. One with none is a bug in core: every core raise is
      // coded, so the net reports it as `MX_INTERNAL_ERROR`, not uncoded.
      diagnosticCodeOf(error) ?? INTERNAL_ERROR_CODE,
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
  const rank = (d: IrDiagnostic) => (isUnpositionedPrefix(d.message) ? 1 : 0);
  const sorted = out
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
  return causesFirst(sorted);
}

/**
 * A "Missing ending tag" error is reported at the tag's `<`, so by position it
 * comes before every error inside the tag. When one of those is an expression
 * error in the tag's own open tag, it is the cause: the expression read the
 * tag's `>` as part of itself (`<for of=[1]|x|>` reads `|>` as the pipeline
 * operator), the open tag never ended, and the missing end tag is what follows.
 * Stock Marko reports the cause first, and so do we.
 *
 * "Inside the open tag" is the cascade's own range: a missing end tag spans
 * the open tag (all the text it swallowed when the expression ran past the
 * `>`). Only an `MX_PARSE_EXPRESSION` or `MX_EXPECTED_SINGLE_EXPRESSION` whose start is inside that range moves,
 * to just before the cascade, in the order it had. Every other error keeps its
 * position order, so an unrelated error before or after the tag does not move.
 */
function isExpressionCode(code: string | undefined): boolean {
  return (
    code === PARSE_EXPRESSION_CODE || code === EXPECTED_SINGLE_EXPRESSION_CODE
  );
}

function causesFirst(sorted: IrDiagnostic[]): IrDiagnostic[] {
  const cascades = sorted.filter((d) => d.code === MISSING_END_TAG_CODE);
  if (cascades.length === 0) return sorted;
  const causeOf = (d: IrDiagnostic): IrDiagnostic | undefined => {
    if (!isExpressionCode(d.code)) return undefined;
    // The innermost cascade whose open tag holds the error.
    let found: IrDiagnostic | undefined;
    for (const cascade of cascades) {
      if (
        cascade.end !== undefined &&
        (cascade.file ?? "") === (d.file ?? "") &&
        d.offset >= cascade.offset &&
        d.offset < cascade.end.offset &&
        (found === undefined || cascade.offset >= found.offset)
      ) {
        found = cascade;
      }
    }
    return found;
  };
  const before = new Map<IrDiagnostic, IrDiagnostic[]>();
  const rest: IrDiagnostic[] = [];
  for (const d of sorted) {
    const cascade = causeOf(d);
    if (cascade === undefined) {
      rest.push(d);
      continue;
    }
    before.set(cascade, [...(before.get(cascade) ?? []), d]);
  }
  return rest.flatMap((d) => [...(before.get(d) ?? []), d]);
}

/**
 * `extra` errors merged into `errors` (already in {@link errorDiagnostics}
 * order) by position: an `extra` error comes before an error at the same
 * place, and the unpositioned errors stay last. An error with the same
 * message at the same place as an `extra` one is the same finding, reported
 * once, as the `extra` one (which carries a code).
 */
export function mergeDiagnostics(
  errors: readonly IrDiagnostic[],
  extra: readonly IrDiagnostic[],
): IrDiagnostic[] {
  const rank = (d: IrDiagnostic) => (isUnpositionedPrefix(d.message) ? 1 : 0);
  const key = (d: IrDiagnostic) =>
    `${d.file ?? ""}:${d.line}:${d.column}:${d.message}`;
  const known = new Set(extra.map(key));
  return [...extra, ...errors.filter((d) => !known.has(key(d)))]
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

/** 1-based line, 0-based column of a file offset, as core positions. */
export function positionAt(
  lineStarts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] as number) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - (lineStarts[low] as number) };
}
