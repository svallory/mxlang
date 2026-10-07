/**
 * Positioned diagnostics for the class/id shorthand (decision 174).
 *
 * The shorthand keeps its simple rules (a part ends at whitespace, `.`, `#`,
 * `/`, `(`, `=`, `>`; `:` starts the name sugar), but two spellings compile to
 * a *silent* wrong class and one dies inside Marko's parser with text about
 * tag variables:
 *
 * - `<div.bg-[#fff]/>` splits at the `#`, so the class `bg-[` and the id
 *   `fff]` both compile clean — the wrong output, with no error;
 * - `<div.w-1.5/>` makes `5` a class of its own: `class="w-1 5"`;
 * - `<div.w-1/2/>` reads `2` as a tag variable and reports Marko's own
 *   message with a link to the Marko docs.
 *
 * Every one of them is caught before Marko parses, with the parser MX itself
 * resolves: the stock `htmljs-parser` reports each shorthand part
 * (`onTagShorthandClass`/`onTagShorthandId`) with its exact source span, and
 * reports them even where the later Babel parse would fail — so the same scan
 * answers the silent cases and the parse-error cases with one positioned
 * error per offending part, naming the `class="…"` escape hatch.
 *
 * The scan is tag-adjacent shorthand only: attribute-position sugar
 * (`<div class="x" .y>`) surfaces as an ordinary attribute, never through the
 * shorthand events, and is checked where it is rewritten
 * (`name-sugar.ts` uses this module's messages for its own positioned checks).
 */

import { TranslateError } from "./core.ts";
import { markoParser } from "./stock-parser.ts";

/** Decision 174: the escape hatch every shorthand diagnostic advises. */
const CLASS_HINT = 'write the class as `class="…"`';

/** A shorthand part whose brackets split it into something else (`bg-[`). */
export const shorthandBracketMessage = (sigil: string, word: string): string =>
  `\`${sigil}${word}\` is not a valid shorthand class: a shorthand part cannot contain \`[\` or \`]\` (${CLASS_HINT})`;

/** A class part that is a bare number (`5`, from `.w-1.5`). */
export const shorthandDigitMessage = (word: string): string =>
  `\`.${word}\` is not a valid shorthand class: a numeric part splits off what precedes it (\`.w-1.5\` gives \`class="w-1 5"\`); write the class as \`class="…"\``;

/** A `/` right after a shorthand, followed by a non-identifier (`.w-1/2`). */
export const shorthandSlashMessage = (word: string, next: string): string =>
  `\`.${word}/${next}\` cannot be written as class shorthand: the \`/\` after the shorthand starts a tag variable, and \`${next}\` is not one; write the class as \`class="${word}/${next}"\``;

/** 1-based line and 0-based column of `offset`, as `TranslateError` takes them. */
function lineColumnOf(
  source: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (;;) {
    const next = source.indexOf("\n", lineStart);
    if (next === -1 || next >= offset) {
      return { line, column: offset - lineStart };
    }
    line++;
    lineStart = next + 1;
  }
}

/** The start of an identifier: what may follow a `/` that starts a tag variable. */
const IDENTIFIER_START = /[A-Za-z_$]/;

interface ShorthandPart {
  sigil: "." | "#";
  /** The part's static text, `undefined` when the part holds a `${…}`. */
  word: string | undefined;
  /** Offset of the sigil itself. */
  start: number;
  /** Offset one past the part's last character. */
  end: number;
}

/**
 * The shorthand parts of every tag head in `source`, as the parser MX resolves
 * sees them. A parse error does not stop the scan: `onError` is ignored and
 * the parts already reported stand (the failing spelling is caught by the
 * checks below before Marko's own error matters).
 */
function shorthandParts(source: string): ShorthandPart[] {
  const parts: ShorthandPart[] = [];
  const parser = markoParser();
  if (!parser) return parts;
  const read =
    (sigil: "." | "#") =>
    (text: {
      quasis?: { start: number; end: number }[];
      expressions?: unknown[];
    }) => {
      const quasis = text?.quasis;
      if (!Array.isArray(quasis) || quasis.length === 0) return;
      const start = quasis[0]?.start;
      const end = quasis[quasis.length - 1]?.end;
      if (typeof start !== "number" || typeof end !== "number") return;
      const word =
        (text.expressions?.length ?? 0) > 0
          ? undefined
          : source.slice(start, end);
      parts.push({ sigil, word, start: start - 1, end });
    };
  try {
    parser
      .createParser({
        onTagShorthandClass: read("."),
        onTagShorthandId: read("#"),
        onError: () => {},
      })
      .parse(source);
  } catch {
    // A parse that throws still reported the parts before it.
  }
  return parts;
}

/**
 * The first shorthand diagnostic in `source`, positioned at the offending
 * part's sigil (decision 174): an unbalanced `[`/`]` in a part, a class part
 * starting with a digit, or a `/` after a shorthand followed by a
 * non-identifier. `undefined` when every shorthand part is one Marko accepts.
 */
export function shorthandDiagnostic(
  source: string,
): { message: string; offset: number } | undefined {
  for (const part of shorthandParts(source)) {
    const { sigil, word, start, end } = part;
    if (word !== undefined && /[[\]]/.test(word)) {
      return { message: shorthandBracketMessage(sigil, word), offset: start };
    }
    // A bare-numeric class part (`5` from `.w-1.5`, never `2xl`, which is a
    // name the author wrote whole): the split that silently changes the class.
    if (
      sigil === "." &&
      word !== undefined &&
      /^[0-9]/.test(word) &&
      !/[A-Za-z]/.test(word)
    ) {
      return { message: shorthandDigitMessage(word), offset: start };
    }
    // `/` right after the part: a tag variable (`<div.a/b>`) or the
    // self-closing `/>`. Anything else (`.w-1/2`) is a class the shorthand
    // cannot hold.
    if (source[end] === "/") {
      let at = end + 1;
      while (/\s/.test(source[at] ?? "")) at++;
      const next = source[at] ?? "";
      if (next !== "" && next !== ">" && !IDENTIFIER_START.test(next)) {
        return {
          message: shorthandSlashMessage(word ?? "…", next),
          offset: end,
        };
      }
    }
  }
  return undefined;
}

/**
 * `shorthandDiagnostic` as a thrown `TranslateError`, or `undefined`. The one
 * raised diagnostic for a whole file: every target funnels its parse through
 * `compileSource` (whole-file) or `parseFragment` (a region), and both call
 * this before Marko parses, so no target sees the silent wrong class.
 */
export function shorthandDiagnosticError(
  source: string,
): TranslateError | undefined {
  const found = shorthandDiagnostic(source);
  if (!found) return undefined;
  const { line, column } = lineColumnOf(source, found.offset);
  return new TranslateError(found.message, line, column);
}
