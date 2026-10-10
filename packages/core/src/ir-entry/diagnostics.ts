/**
 * Errors and warnings to `IrDiagnostic`s, for the IR entry point
 * (`lowerSource`). Moved from `@mxlang/data`'s `parseData` with the same
 * positions, ordering, deduplication and prefixes.
 */

import { resolve } from "node:path";
import { isTranslateError } from "../core.ts";

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
   * A machine-readable code, when the error carries one
   * (`TranslateError.diagnosticCode`): today a syntax module's
   * `ctx.fail(message, { code })`. @unstable
   */
  code?: string;
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
  at: { line: number; column: number; file?: string },
  code: string | undefined,
  lineStarts: number[],
  source: string,
  filename: string,
): IrDiagnostic {
  // `file` names another file only: core sets it on some errors positioned
  // in the lowered file too (a syntax module's, a table error's), so it is
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
  return {
    severity,
    message,
    line,
    column,
    offset: foreign ? -1 : offsetOf(lineStarts, source, line, column),
    ...(foreign ? { file: at.file } : {}),
    ...(code !== undefined ? { code } : {}),
  };
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
      // Only a `TranslateError`'s: a Babel or system error's `code` is not ours.
      isTranslateError(error) && typeof error.diagnosticCode === "string"
        ? error.diagnosticCode
        : undefined,
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
