/**
 * A clearer message for a structural attribute (`*ngIf="…"`) that follows
 * another attribute.
 *
 * Marko reads an attribute value greedily, so in `<div class="a" *ngIf="x">`
 * the text ` *ngIf` continues `"a"` as a multiplication and the `=` after it
 * turns the expression into an assignment to a non-assignable target. Marko
 * throws `Invalid left-hand side in assignment expression.` at the *value*
 * (`"a"`), which names neither the attribute that swallowed the directive nor
 * the fix. The parse is Marko's and stays exactly that: this only rewrites
 * the message of the error Marko already threw.
 *
 * Detection never trusts the error's `line`/`column` (Bun gives every `Error`
 * some). It needs all of: Marko's own `CompileError` name, a numeric
 * `loc.start.index` (the offset of the value Marko gave up on), and, in the
 * source from that offset, a value that is followed at bracket depth 0 by
 * whitespace and `*name=`. That shape is an error in Marko whatever `name`
 * is (no valid template has `value *name=`), so any name is explained, not
 * only `ng*`: `*transloco`, `*cdkVirtualFor` and project directives hit the
 * same wall. `a=b *c` and `a=(b * c)` never reach this code (they compile),
 * and a failure without `*name=` after the value (`a=1 +b=2`) is left alone.
 */

import {
  type CompileResult,
  compileSource,
  TranslateError,
} from "@mxlang/core";
import { offsetAt } from "./mapping.ts";

/** The `*name=` Marko swallowed, and the attribute whose value swallowed it. */
export interface StructuralAttr {
  /** Offset of the `*` in the scanned text. */
  index: number;
  /** The directive, without the `*`. */
  name: string;
  /** The attribute before it, or `undefined` when it cannot be read back. */
  previous: string | undefined;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[\w$.-]/;

/** The offset just past the string or template literal opening at `i`. */
function skipQuoted(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote) {
    j += text[j] === "\\" ? 2 : 1;
  }
  return j + 1;
}

/** `*name=` at `i` (a `*`), or `undefined`. A `==` or `=>` is not an attribute `=`. */
function structuralAt(
  text: string,
  i: number,
): { name: string; end: number } | undefined {
  if (text[i] !== "*" || !IDENT_START.test(text[i + 1] ?? "")) return undefined;
  let j = i + 1;
  while (j < text.length && IDENT_PART.test(text[j] as string)) j++;
  const name = text.slice(i + 1, j);
  while (/\s/.test(text[j] ?? "")) j++;
  if (text[j] !== "=" || text[j + 1] === "=" || text[j + 1] === ">") {
    return undefined;
  }
  return { name, end: j };
}

/**
 * Finds the `*name=` that the attribute value starting at `valueStart`
 * swallowed, scanning to the end of the tag at most.
 */
export function findStructuralAttr(
  text: string,
  valueStart: number,
): StructuralAttr | undefined {
  let depth = 0;
  for (let i = valueStart; i < text.length; ) {
    const c = text[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(text, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === ">" && text[i - 1] !== "=") return undefined;
    else if (depth === 0 && c === "*" && /\s/.test(text[i - 1] ?? "")) {
      const found = structuralAt(text, i);
      if (found) {
        return {
          index: i,
          name: found.name,
          previous: previousAttribute(text, valueStart),
        };
      }
    }
    i++;
  }
  return undefined;
}

/** The name of the attribute whose `=` ends just before `valueStart`. */
function previousAttribute(
  text: string,
  valueStart: number,
): string | undefined {
  const before = text.slice(0, valueStart);
  return /([^\s=<>"'`/]+)\s*:?=\s*$/.exec(before)?.[1];
}

/** The hint text for a swallowed `*name=` after `previous=…`. */
export function structuralAttrMessage(attr: StructuralAttr): string {
  const after = attr.previous ? `\`${attr.previous}=…\`` : "another attribute";
  const tag =
    attr.name === "ngFor"
      ? "`<for|item| of=items>…</for>`"
      : attr.name === "ngIf"
        ? "`<if=cond>…</if>`"
        : "`<if=cond>…</if>` or `<for|item| of=items>…</for>`";
  return (
    `\`*${attr.name}\` cannot follow another attribute: after ${after}, ` +
    "Marko reads it as a multiplication, so this does not parse. " +
    "Make it the first attribute of the tag, " +
    `or write ${tag} instead.`
  );
}

/** Babel's reason for an assignment to a non-assignable target. */
const INVALID_LHS = "Invalid left-hand side in assignment expression.";

/** The narrow shape of the two errors that carry the failure. */
interface ParseFailure {
  name?: unknown;
  message?: unknown;
  line?: unknown;
  column?: unknown;
  loc?: { start?: { line?: unknown; column?: unknown } };
}

/**
 * The 1-based line and 0-based column of the value Marko gave up on, from
 * either error the failure arrives as: Marko's own `CompileError` (whole-file
 * compiles; the position is `loc.start`) or core's `TranslateError` (a `.ng.mx`
 * region, where core lowers an expression Marko had already marked invalid;
 * the position is `line`/`column`). Each is identified by its deliberate
 * `name`, never by the mere presence of `line`/`column`.
 */
function failurePosition(
  error: ParseFailure,
): { line: number; column: number } | undefined {
  const at =
    error.name === "CompileError"
      ? error.loc?.start
      : error.name === "TranslateError"
        ? error
        : undefined;
  return typeof at?.line === "number" && typeof at.column === "number"
    ? { line: at.line, column: at.column }
    : undefined;
}

/**
 * The positioned hint for `error`, or `undefined` when `error` is not the
 * swallowed-`*name=` failure (the caller then rethrows `error` untouched).
 *
 * `text` is the source the error's position refers to: the file, or for a
 * `.ng.mx` region its `positionRegionSource`, which keeps file coordinates.
 */
export function structuralAttrHint(
  error: unknown,
  text: string,
  filename: string,
): TranslateError | undefined {
  const failure = (error ?? {}) as ParseFailure;
  if (typeof failure.message !== "string") return undefined;
  if (!failure.message.includes(INVALID_LHS)) return undefined;
  const start = failurePosition(failure);
  if (!start) return undefined;
  const valueStart = offsetAt(text, start);
  const attr = findStructuralAttr(text, valueStart);
  if (!attr) return undefined;

  // The `*` sits after the value's start, on the same line or a later one.
  // A later line's column is its own (only a region's first line is shifted),
  // the same line's is moved on by the gap.
  const gap = text.slice(valueStart, attr.index);
  const lastBreak = gap.lastIndexOf("\n");
  const newlines = gap.split("\n").length - 1;
  const line = start.line + newlines;
  const column =
    lastBreak === -1 ? start.column + gap.length : gap.length - lastBreak - 1;
  return new TranslateError(
    structuralAttrMessage(attr),
    line,
    column,
    filename,
  );
}

/**
 * Runs `run`; if it throws the swallowed-`*name=` failure, throws the hint
 * instead, otherwise rethrows the original error untouched.
 */
export function withStructuralAttrHint<T>(
  text: string,
  filename: string,
  run: () => T,
): T {
  try {
    return run();
  } catch (error) {
    throw structuralAttrHint(error, text, filename) ?? error;
  }
}

/** `compileSource`, with the swallowed-`*name=` failure explained. */
export function compileSourceWithHint(
  ...args: Parameters<typeof compileSource>
): CompileResult {
  const [source, filename] = args;
  return withStructuralAttrHint(source, filename, () => compileSource(...args));
}
