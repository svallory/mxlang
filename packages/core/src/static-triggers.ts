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
 * The match follows the template scanner (the parser's `lexTrigger`): a
 * first character arms one row (a `chars` set is compared by that
 * character), the row's `match` must match there in full, the text is not
 * inside a word or right after the same character (`a &&b`), the token does
 * not continue past the match, and an operand is expected there (the
 * parser's `expectsExpression`: not after an operand, a postfix `++`/`--` or
 * `!`, TypeScript's `?`/`!` markers, a type argument list's `>` or a regular
 * expression; after `...` and operator keywords). Comments, strings, regular
 * expressions and template-literal text are masked out; a `${…}`
 * substitution is code.
 *
 * Where it differs from the template: the parser's `claim` hook and its
 * non-ASCII `stopsShortOfToken` decline are not applied, and a statement
 * start that is not after an `if`/`for`/`while`/`with` head (after a block's
 * `}`, or after a line break that ends a statement) expects no operand, so a
 * row that is a whole expression statement there is not found.
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

/** Words whose `( … )` head is followed by a statement. */
const HEAD_WORDS = new Set(["if", "for", "while", "with"]);

const WORD = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]/u;
const isWord = (char: string | undefined): boolean =>
  char !== undefined && WORD.test(char);
const isSpace = (char: string | undefined): boolean =>
  char !== undefined && /\s/.test(char);
const isLineBreak = (char: string | undefined): boolean =>
  char === "\n" || char === "\r" || char === " " || char === " ";

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

/** What the text before a position says about an operand: read on masked text. */
interface Facts {
  /** Offsets just past a regular expression literal (flags included). */
  readonly regexEnds: Set<number>;
  /** Offsets of a `)` that closes an `if`/`for`/`while`/`with` head. */
  readonly headEnds: Set<number>;
}

/** The index of the last non-space character before `at`, or -1. */
function lastIndexBefore(text: string, at: number): number {
  let i = at - 1;
  while (i >= 0 && isSpace(text[i])) i--;
  return i;
}

/** The start of the word that ends at `end` (inclusive). */
function wordStart(text: string, end: number): number {
  let start = end;
  while (start > 0 && isWord(text[start - 1])) start--;
  return start;
}

/** Whether the word ending at `end` is an operator keyword (not a member name). */
function isOperatorWord(text: string, end: number): boolean {
  const start = wordStart(text, end);
  if (start > 0 && text[start - 1] === ".") {
    // `a.new` is a member; `...new` is a spread of an expression.
    if (!(text[start - 2] === "." && text[start - 3] === ".")) return false;
  }
  const word = text.slice(start, end + 1);
  if (!OPERAND_WORDS.has(word)) return false;
  if (word === "of") {
    // `of` is an operator only after an operand (`for (x of …)`).
    const j = lastIndexBefore(text, start);
    return j >= 0 && (isWord(text[j]) || ")]}".includes(text[j] as string));
  }
  return true;
}

/** Whether the `>` at `end` closes a type argument list (`Array<T>`). */
function closesTypeArguments(text: string, end: number): boolean {
  let angles = 0;
  let groups = 0;
  for (let j = end; j >= 0; j--) {
    const char = text[j] as string;
    switch (char) {
      case ">":
        if (text[j - 1] !== "=") angles++;
        break;
      case "<":
        if (--angles === 0) {
          return groups === 0 && j > 0 && isWord(text[j - 1]);
        }
        break;
      case ")":
      case "]":
      case "}":
        groups++;
        break;
      case "(":
      case "[":
      case "{":
        if (--groups < 0) return false;
        break;
      case ";":
        return false;
      case "?":
      case ":":
        if (groups === 0) return false;
        break;
      case "&":
      case "|":
        if (text[j - 1] === char) return false;
        break;
    }
  }
  return false;
}

/** Whether the `+`/`-` at `i` ends a postfix `++`/`--`: an operand ends there. */
function endsPostfixUpdate(
  text: string,
  facts: Facts,
  i: number,
  beforePair: boolean,
): boolean {
  const char = text[i];
  let first = i;
  while (first > 0 && text[first - 1] === char) first--;
  if (i - first !== 1 || beforePair) return false;
  // A line break before the pair makes it a prefix update.
  for (let j = first - 1; j >= 0 && isSpace(text[j]); j--) {
    if (isLineBreak(text[j])) return false;
  }
  return !expectsOperand(text, facts, first, true);
}

/**
 * Whether an operand is expected at `at` (the parser's `expectsExpression`):
 * `text` is the masked statement, `at` the offset asked about.
 */
function expectsOperand(
  text: string,
  facts: Facts,
  at: number,
  beforePair = false,
): boolean {
  const i = lastIndexBefore(text, at);
  if (i < 0) return true;
  if (facts.headEnds.has(i)) return true;
  const char = text[i] as string;
  switch (char) {
    case ")":
    case "]":
    case "}":
    case '"':
    case "'":
    case "`":
      return false;
    case ".":
      return text[i - 1] === "." && text[i - 2] === ".";
    case "?": {
      if (i === 0) return true;
      const owner = text[i - 1] as string;
      if (isWord(owner))
        return /\d/.test(text[wordStart(text, i - 1)] as string);
      return !(owner === "]" || owner === "-" || owner === "+");
    }
    case "!": {
      let j = i - 1;
      while (j >= 0 && (text[j] === "!" || isSpace(text[j]))) j--;
      if (j < 0) return true;
      const owner = text[j] as string;
      if (owner === ")" || owner === "]") return false;
      if (owner === "-" || owner === "+") {
        return !endsPostfixUpdate(text, facts, j, false);
      }
      if (!isWord(owner)) return true;
      return isOperatorWord(text, j);
    }
    case ">":
      return text[i - 1] === "=" || !closesTypeArguments(text, i);
    case "+":
    case "-":
      return !endsPostfixUpdate(text, facts, i, beforePair);
    case "/":
      return !facts.regexEnds.has(i + 1);
    default: {
      if (facts.regexEnds.has(i + 1)) return false;
      if (!isWord(char)) return true;
      // A word right against a `:` is an object key or a label.
      if (i === at - 1 && !beforePair && text[at] === ":") return false;
      return isOperatorWord(text, i);
    }
  }
}

/**
 * `text` with comments, string contents, regular expressions and the text of
 * template literals replaced by spaces (a `${…}` substitution stays code),
 * every offset unchanged, and what the masking learned about the code.
 */
function mask(text: string): { masked: string; facts: Facts } {
  const facts: Facts = { regexEnds: new Set(), headEnds: new Set() };
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (!isLineBreak(out[k])) out[k] = " ";
    }
  };
  const current = (): string => out.join("");
  // Open parens: whether each follows an if/for/while/with.
  const parens: boolean[] = [];
  // Template nesting: the brace depth to return to at each open `${`.
  const braces: number[] = [];
  let depth = 0;
  let i = 0;
  const template = (): void => {
    // `i` is after the opening backtick or the closing `}` of a `${`.
    const from = i;
    while (i < text.length) {
      const char = text[i] as string;
      if (char === "\\") i += 2;
      else if (char === "`") {
        blank(from, i);
        i++;
        return;
      } else if (char === "$" && text[i + 1] === "{") {
        blank(from, i);
        i += 2;
        braces.push(depth);
        depth = 0;
        return;
      } else i++;
    }
    blank(from, text.length);
  };
  while (i < text.length) {
    const char = text[i] as string;
    const next = text[i + 1];
    if (char === "/" && next === "/") {
      const from = i;
      while (i < text.length && !isLineBreak(text[i])) i++;
      blank(from, i);
      continue;
    }
    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      const to = close < 0 ? text.length : close + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (char === '"' || char === "'") {
      const from = ++i;
      while (i < text.length && text[i] !== char && !isLineBreak(text[i])) {
        i += text[i] === "\\" ? 2 : 1;
      }
      blank(from, i);
      i++;
      continue;
    }
    if (char === "`") {
      i++;
      template();
      continue;
    }
    if (char === "/") {
      if (expectsOperand(current(), facts, i)) {
        // A regular expression literal.
        const from = i + 1;
        let inClass = false;
        i++;
        while (i < text.length && !isLineBreak(text[i])) {
          const c = text[i] as string;
          if (c === "\\") i++;
          else if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) break;
          i++;
        }
        blank(from, i);
        i++;
        while (isWord(text[i])) i++;
        facts.regexEnds.add(i);
        continue;
      }
      i++;
      continue;
    }
    if (char === "(") {
      const j = lastIndexBefore(current(), i);
      parens.push(
        j >= 0 &&
          isWord(text[j]) &&
          HEAD_WORDS.has(text.slice(wordStart(text, j), j + 1)),
      );
    } else if (char === ")") {
      if (parens.pop() === true) facts.headEnds.add(i);
    } else if (char === "{") depth++;
    else if (char === "}") {
      if (depth === 0 && braces.length > 0) {
        depth = braces.pop() as number;
        i++;
        template();
        continue;
      }
      depth--;
    }
    i++;
  }
  return { masked: current(), facts };
}

/** The first dialect expression row `text` writes outside comments and strings, if any. */
export function firstRowIn(
  text: string,
  rows: readonly Trigger[],
): StatementHit | undefined {
  const compiled = compile(rows);
  if (compiled.length === 0) return undefined;
  const { masked, facts } = mask(text);
  let i = 0;
  while (i < masked.length) {
    const point = String.fromCodePoint(masked.codePointAt(i) as number);
    const armed = compiled.find((each) => each.first.test(point));
    if (armed) {
      armed.matcher.lastIndex = i;
      const found = armed.matcher.exec(masked);
      if (found !== null && found[0].length > 0) {
        const end = i + found[0].length;
        const { standIn } = armed.row;
        const continues =
          standIn !== "keep" &&
          (isWord(masked[end]) ||
            (standIn === "number" &&
              found[0].length === 1 &&
              masked[end] === "."));
        if (
          !continues &&
          !(i > 0 && isWord(masked[i - 1])) &&
          !(i > 0 && masked[i - 1] === masked[i]) &&
          expectsOperand(masked, facts, i)
        ) {
          return { row: armed.row, start: i, end };
        }
      }
    }
    i += point.length;
  }
  return undefined;
}
