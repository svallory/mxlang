/**
 * A dialect expression row written in a module statement.
 *
 * A dialect's expression rows lower inside an expression of the template,
 * where the parser announces them. A module statement (`static`, `server`,
 * `client`, `export`) is module code: the parser announces nothing in it,
 * and its text reaches the module as written. A row's lowering may read the
 * render scope (`self`), which a module statement has not. So a row written
 * there is refused, at its first character, instead of being left to read
 * as the JavaScript it happens to look like (`~zz` is a bitwise NOT).
 *
 * The match is the template scanner's: a first character arms one row (a
 * `chars` set is compared by that character), the row's `match` must match
 * there in full, a trigger never starts inside a word or continues a
 * punctuator of the same character (`a &&b`), and it stands where an operand
 * is expected. Comments, strings and template-literal text are skipped.
 */
import type { Trigger } from "./syntax-table.ts";

/** A row the statement's text matched: its offset in the statement and its text. */
export interface StatementHit {
  readonly row: Trigger;
  readonly start: number;
  readonly end: number;
}

/** Words after which an operand is expected (the template scanner's list). */
const OPERAND_WORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/** Characters after which an operand is expected. */
const OPERAND_AFTER = new Set([..."([{,;:=?!~+-*/%<>&|^"]);

const WORD = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]/u;

interface Compiled {
  readonly row: Trigger;
  readonly first: RegExp;
  readonly matcher: RegExp;
}

const compiledRows = new WeakMap<readonly Trigger[], Compiled[]>();

function compile(rows: readonly Trigger[]): Compiled[] {
  let compiled = compiledRows.get(rows);
  if (!compiled) {
    compiled = rows.flatMap((row) => {
      try {
        return [
          {
            row,
            first: new RegExp(`^[${row.chars}]$`, "u"),
            matcher: new RegExp(
              row.match.startsWith("^") ? row.match.slice(1) : row.match,
              "uy",
            ),
          },
        ];
      } catch {
        return [];
      }
    });
    compiledRows.set(rows, compiled);
  }
  return compiled;
}

/** The last significant text before `at`: the character and, for a word, the word. */
function before(text: string, at: number): { char: string; word: string } {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text[i] as string)) i--;
  if (i < 0) return { char: "", word: "" };
  let from = i;
  while (from > 0 && WORD.test(text[from - 1] as string)) from--;
  return { char: text[i] as string, word: text.slice(from, i + 1) };
}

/** Whether the text before `at` leaves an operand expected. */
function expectsOperand(text: string, at: number): boolean {
  const { char, word } = before(text, at);
  if (char === "") return true;
  if (WORD.test(char)) return OPERAND_WORDS.has(word);
  return OPERAND_AFTER.has(char);
}

/** The first dialect expression row `text` writes outside comments and strings, if any. */
export function firstRowIn(
  text: string,
  rows: readonly Trigger[],
): StatementHit | undefined {
  const compiled = compile(rows);
  if (compiled.length === 0) return undefined;
  // Template literals nest: each open `${` pushes the depth to return at.
  const braces: number[] = [];
  let depth = 0;
  let i = 0;
  const skipTemplate = (): void => {
    // `i` is after the opening backtick or the closing `}` of a `${`.
    while (i < text.length) {
      const char = text[i] as string;
      if (char === "\\") i += 2;
      else if (char === "`") {
        i++;
        return;
      } else if (char === "$" && text[i + 1] === "{") {
        i += 2;
        braces.push(depth);
        depth = 0;
        return;
      } else i++;
    }
  };
  while (i < text.length) {
    const char = text[i] as string;
    const next = text[i + 1];
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      i++;
      while (i < text.length && text[i] !== char && text[i] !== "\n") {
        i += text[i] === "\\" ? 2 : 1;
      }
      i++;
      continue;
    }
    if (char === "`") {
      i++;
      skipTemplate();
      continue;
    }
    if (char === "/" && expectsOperand(text, i)) {
      // A regular expression literal.
      let inClass = false;
      i++;
      while (i < text.length && text[i] !== "\n") {
        const c = text[i] as string;
        if (c === "\\") i++;
        else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        i++;
      }
      i++;
      continue;
    }
    if (char === "{") depth++;
    if (char === "}") {
      if (depth === 0 && braces.length > 0) {
        depth = braces.pop() as number;
        i++;
        skipTemplate();
        continue;
      }
      depth--;
    }
    const point = String.fromCodePoint(text.codePointAt(i) as number);
    const armed = compiled.find((each) => each.first.test(point));
    if (armed) {
      armed.matcher.lastIndex = i;
      const found = armed.matcher.exec(text);
      if (
        found !== null &&
        found[0].length > 0 &&
        !(i > 0 && WORD.test(text[i - 1] as string)) &&
        !(i > 0 && text[i - 1] === text[i]) &&
        expectsOperand(text, i)
      ) {
        return { row: armed.row, start: i, end: i + found[0].length };
      }
    }
    i += point.length;
  }
  return undefined;
}
