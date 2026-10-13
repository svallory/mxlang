/**
 * Where the token an expression error points at ends.
 *
 * Babel reports a position, and Marko's error is that one point. A diagnostic
 * is more useful over the token Babel stopped at (the `|>` of `<for
 * of=[1]|x|>`, not the character before it), so the error's `end` is moved to
 * the token's end. The position the token starts at is Babel's own; its
 * length is read lexically, so an odd token (a template literal, a regular
 * expression) gets one character at worst.
 */
import type { Node } from "./core.ts";

/** JavaScript's multi-character punctuators, longest first. */
const PUNCTUATORS = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<",
  ">>",
  "**",
  "|>",
] as const;

const WORD = /^(?:#?[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*|\.?\d[\w.]*)/u;

/**
 * The length of the token that starts at `at` in `text`: an identifier or
 * keyword, a number, a string (to its closing quote, or to the end of the
 * line when it has none), a multi-character punctuator, else one character.
 * `0` at the end of `text`.
 */
export function tokenLengthAt(text: string, at: number): number {
  const rest = text.slice(at, at + 4096);
  if (rest.length === 0) return 0;
  const word = WORD.exec(rest);
  if (word) return word[0].length;
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    for (let i = 1; i < rest.length; i++) {
      const char = rest[i];
      if (char === "\\") i++;
      else if (char === quote) return i + 1;
      else if (char === "\n" || char === "\r") return i;
    }
    return rest.length;
  }
  for (const punctuator of PUNCTUATORS) {
    if (rest.startsWith(punctuator)) return punctuator.length;
  }
  return String.fromCodePoint(rest.codePointAt(0) ?? 0).length;
}

/**
 * The end of a parse error, in the offsets it was given in. A point error of
 * an expression container (`origin: "expression"`, `start === end`, inside
 * the container) ends where its token does, no later than the container's
 * end. Any other error keeps its own `end`; so does one at the very end of
 * its container, where there is no token to cover.
 *
 * `text` is the source and `base` the offset its first character has in the
 * error's offsets (`0` when they agree).
 */
export function parseErrorEnd(error: Node, text: string, base: number): number {
  const container = error.context;
  if (
    error.origin !== "expression" ||
    error.end !== error.start ||
    container == null ||
    error.start < container.start ||
    error.start >= container.end
  ) {
    return error.end;
  }
  const token = tokenLengthAt(text, error.start - base);
  return Math.min(error.start + token, container.end);
}
