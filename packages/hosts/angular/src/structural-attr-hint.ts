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
 * Detection never trusts the mere presence of `line`/`column` (Bun gives every
 * `Error` some). It needs all of: a `CompileError` (or core's `TranslateError`,
 * for a `.ng.mx` region) by `name`, with Babel's reason text, for this file
 * itself (no `file`); the value it points at must be an attribute value in an
 * open tag; and, in the source from that value, only operator-joined text
 * at bracket depth 0 may separate it from whitespace and `*name=`, before
 * the tag ends. That shape is an error in Marko whatever `name`
 * is (no valid template has `value *name=`), so any name is explained, not
 * only `ng*`: `*transloco`, `*cdkVirtualFor` and project directives hit the
 * same wall. `a=b *c` and `a=(b * c)` never reach this code (they compile),
 * and a failure without `*name=` right after the value (`a=1 +b=2`) is left
 * alone. A file with several failures arrives as one `CompileErrors`
 * aggregate; each member is judged on its own, and those that do not match
 * keep Marko's text byte for byte.
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

const OPERATOR = /[-+*/%&|^<>=!?:,.~]/;

/** Whether `from..valueStart` is the inside of one open tag: brackets balance, no `>` closes it. */
function balancedTagPrefix(
  text: string,
  from: number,
  valueStart: number,
): boolean {
  let depth = 0;
  for (let i = from; i < valueStart; ) {
    const c = text[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(text, i);
      // A quote that runs past the value (or never closes) is not a string
      // inside this tag: the `<` this prefix started at was not a tag start.
      if (i > valueStart) return false;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === ">" && text[i - 1] !== "=") return false;
    if (depth < 0) return false;
    i++;
  }
  return depth === 0;
}

/** The value at `valueStart` follows `name=` or a `...` spread. */
function followsAttribute(text: string, valueStart: number): boolean {
  return (
    previousAttribute(text, valueStart) !== undefined ||
    /(^|\s)\.\.\.\s*$/.test(text.slice(0, valueStart))
  );
}

/**
 * Whether `text[valueStart]` begins an attribute value inside an open tag,
 * in either syntax. A scriptlet (`$ x = 1 = 2`) or a `${…}` placeholder is
 * neither.
 *
 * HTML syntax: some earlier `<` opens a tag name and nothing between it and
 * the value closes the tag or unbalances a bracket. Earlier `<`s are tried
 * nearest first, because a `<` inside an earlier value (`a=1<2`, `a=(x<y)`)
 * is not a tag start and fails the test on its own.
 *
 * Concise syntax: the value's line, from its indentation, starts with a tag
 * name (a letter or `@`, so `$` scriptlets are out) and the rest of the line
 * up to the value is balanced.
 */
function insideOpenTag(text: string, valueStart: number): boolean {
  if (!followsAttribute(text, valueStart)) return false;
  for (
    let open = text.lastIndexOf("<", valueStart);
    open !== -1;
    open = open === 0 ? -1 : text.lastIndexOf("<", open - 1)
  ) {
    if (
      /[A-Za-z@_$/{]/.test(text[open + 1] ?? "") &&
      balancedTagPrefix(text, open + 1, valueStart)
    ) {
      return true;
    }
  }
  const lineStart = text.lastIndexOf("\n", valueStart - 1) + 1;
  const line = text.slice(lineStart, valueStart);
  const name = /^[ \t]*[A-Za-z@][\w.:#@-]*(?=[\s(])/.exec(line);
  return (
    name !== null &&
    balancedTagPrefix(text, lineStart + name[0].length, valueStart)
  );
}

/**
 * Finds the `*name=` that the attribute value starting at `valueStart`
 * swallowed: the failing value must be an attribute value of an open tag, and
 * only operator-joined text may lie between it and the directive, so a
 * directive past another attribute, or in another tag, is not it.
 */
export function findStructuralAttr(
  text: string,
  valueStart: number,
): StructuralAttr | undefined {
  if (!insideOpenTag(text, valueStart)) return undefined;
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
    else if (depth === 0 && /\s/.test(c)) {
      let next = i;
      while (/\s/.test(text[next] ?? "")) next++;
      const found = structuralAt(text, next);
      if (found) {
        return {
          index: next,
          name: found.name,
          previous: previousAttribute(text, valueStart),
        };
      }
      // Whitespace ends the value unless an operator joins the two sides.
      const joined =
        OPERATOR.test(text[i - 1] ?? "") || OPERATOR.test(text[next] ?? "");
      if (!joined) return undefined;
      i = next;
      continue;
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

/** The narrow shape of the errors that carry the failure. */
interface ParseFailure {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  file?: unknown;
  line?: unknown;
  column?: unknown;
  loc?: { start?: { line?: unknown; column?: unknown } };
  errors?: unknown;
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
 * The positioned hint for one error, or `undefined` when it is not the
 * swallowed-`*name=` failure.
 *
 * `file` is left exactly as core's contract has it (`TranslateError.file`,
 * core.ts: set only for an error in a file other than the one being compiled),
 * which for this file's own failure is unset. An error that names another file
 * is not judged at all, since `text` is this file's.
 */
function memberHint(error: unknown, text: string): TranslateError | undefined {
  const failure = (error ?? {}) as ParseFailure;
  if (typeof failure.message !== "string") return undefined;
  if (!failure.message.includes(INVALID_LHS)) return undefined;
  if (failure.file !== undefined) return undefined;
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
  return new TranslateError(structuralAttrMessage(attr), line, column);
}

/** One member of Marko's `CompileErrors`, as that class renders it. */
function aggregatePart(member: { stack?: unknown }): string {
  const prefix = "CompileError: \n    at ";
  const stack = String(member.stack);
  if (stack.startsWith(prefix)) return stack.slice("CompileError: \n".length);
  return stack.replace(/^(?!\s*$)/gm, "    ");
}

/**
 * The error to throw instead of `error`, or `undefined` when `error` is not,
 * and contains nothing that is, the swallowed-`*name=` failure (the caller
 * then rethrows `error` untouched).
 *
 * `text` is the source the error's position refers to: the file, or for a
 * `.ng.mx` region its `positionRegionSource`, which keeps file coordinates.
 *
 * Marko reports several invalid values as one `CompileErrors` aggregate
 * (`errors`). Each member is hinted on its own; the members that do not match
 * stay the very same objects, and the aggregate's message is rebuilt with the
 * same formula Marko uses, so their text is unchanged.
 */
export function structuralAttrHint(
  error: unknown,
  text: string,
): Error | undefined {
  const failure = (error ?? {}) as ParseFailure;
  if (failure.name === "CompileErrors" && Array.isArray(failure.errors)) {
    const members = failure.errors as { stack?: unknown }[];
    const replaced = members.map((member) => memberHint(member, text));
    if (replaced.every((hint) => hint === undefined)) return undefined;
    const errors = members.map((member, i) => replaced[i] ?? member);
    const aggregate = error as Error & { errors: unknown[] };
    const message = `\n${errors
      .map((member, i) =>
        replaced[i]
          ? hintPart(replaced[i] as Positioned)
          : aggregatePart(member),
      )
      .join("\n\n")}`;
    // `failure` and `aggregate` are one object: read the old message before
    // the mutation, or the stack (which embeds it on V8) would keep it.
    const oldMessage = aggregate.message;
    const stack = aggregate.stack;
    aggregate.message = message;
    aggregate.errors = errors;
    if (typeof stack === "string") {
      aggregate.stack = stack.replace(oldMessage, () => message);
    }
    return aggregate;
  }
  return memberHint(error, text);
}

type Positioned = TranslateError;

/** A hint's slot in an aggregate message: position, then the text. */
function hintPart(hint: Positioned): string {
  return `    at ${hint.line}:${hint.column + 1}\n        ${hint.message}`;
}

/**
 * Runs `run`; if it throws the swallowed-`*name=` failure, throws the hint
 * instead, otherwise rethrows the original error untouched.
 */
export function withStructuralAttrHint<T>(text: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw structuralAttrHint(error, text) ?? error;
  }
}

/** `compileSource`, with the swallowed-`*name=` failure explained. */
export function compileSourceWithHint(
  ...args: Parameters<typeof compileSource>
): CompileResult {
  return withStructuralAttrHint(args[0], () => compileSource(...args));
}
