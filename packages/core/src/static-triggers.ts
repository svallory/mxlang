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
 * non-ASCII `stopsShortOfToken` decline are not applied. A module statement
 * is statements, which the template's expression scanner does not model, so
 * a statement start also expects an operand: after a block's `}` (a `}` that
 * closes an `if`/`for`/function/class/`static` body, not an object literal),
 * and after a line break that ends a statement (the next token cannot
 * continue the expression, so automatic semicolon insertion splits there:
 * `f(x)\n~zz`, but not `f(x)\n&zz`, which is a bitwise and).
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

/** A `{ … }`: where it opens and closes, whether it is a class body, its enclosing brace (-1 for none). */
interface Brace {
  readonly start: number;
  end: number;
  readonly cls: boolean;
  readonly parent: number;
}

/** What the text before a position says about an operand: read on masked text. */
interface Facts {
  /** Offsets just past a regular expression literal (flags included). */
  readonly regexEnds: Set<number>;
  /** Offsets of a `)` that closes an `if`/`for`/`while`/`with` head. */
  readonly headEnds: Set<number>;
  /** Offsets of a `}` that closes a block (a statement list), not an object literal. */
  readonly blockEnds: Set<number>;
  /** Every `{ … }` of the statement, in opening order. */
  readonly braces: Brace[];
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
  if (lineBreakBefore(text, first)) return false;
  return !expectsOperand(text, facts, first, true);
}

/**
 * A character that, written after a line break, continues the expression
 * before it (an operator, `(`, `[`, `.`, a template tag, `?`, `:`, `,`,
 * `!=`): no semicolon is inserted before it.
 */
function continuesExpression(text: string, at: number): boolean {
  const char = text[at];
  if (char === undefined) return false;
  if (char === "!") return text[at + 1] === "=";
  return "([+-*/%&|^<>=?:,.`".includes(char);
}

/** Whether the innermost `{ … }` around `at` is a class body. */
function inClassBody(facts: Facts, at: number): boolean {
  const { braces } = facts;
  // The last brace opened before `at`, then outward until one still open.
  let low = 0;
  let high = braces.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((braces[mid] as Brace).start < at) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  while (found >= 0 && (braces[found] as Brace).end <= at) {
    found = (braces[found] as Brace).parent;
  }
  return found >= 0 && (braces[found] as Brace).cls;
}

/** Whether a line break lies between the last token before `at` and `at`. */
function lineBreakBefore(
  text: { readonly [index: number]: string | undefined },
  at: number,
): boolean {
  for (let j = at - 1; j >= 0 && isSpace(text[j]); j--) {
    if (isLineBreak(text[j])) return true;
  }
  return false;
}

/**
 * Whether an operand is expected at `at`: the template scanner's rule
 * (`expectsOperand`'s own), or a statement start after a line break that
 * ends a statement. `text` is the masked statement, `at` the offset asked
 * about.
 */
function expectsOperand(
  text: string,
  facts: Facts,
  at: number,
  beforePair = false,
): boolean {
  if (scannerExpectsOperand(text, facts, at, beforePair)) return true;
  if (beforePair || !lineBreakBefore(text, at)) return false;
  if (continuesExpression(text, at)) return false;
  // A class body's members are no statements: `@dec` and `#private` there
  // are TypeScript, not a row.
  if (inClassBody(facts, at)) return false;
  // `a.` and `a ?` do not end an expression, so no semicolon follows them.
  const char = text[lastIndexBefore(text, at)];
  return char !== "." && char !== "?";
}

/**
 * Whether an operand is expected at `at` (the parser's `expectsExpression`):
 * `text` is the masked statement, `at` the offset asked about.
 */
function scannerExpectsOperand(
  text: string,
  facts: Facts,
  at: number,
  beforePair = false,
): boolean {
  const i = lastIndexBefore(text, at);
  if (i < 0) return true;
  if (facts.headEnds.has(i) || facts.blockEnds.has(i)) return true;
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

/** What a `{` opens, by the construct that opened it. */
type ScopeKind = "block" | "class" | "classExpr" | "object" | "fnExpr";

/** Words after which a `{` is an object literal (an expression), not a block. */
const EXPRESSION_BRACE_WORDS = new Set([
  ...[...OPERAND_WORDS].filter((word) => word !== "else" && word !== "do"),
  "as",
  "satisfies",
  "default",
]);

/** Words that may precede a method's name in a class or object body. */
const METHOD_PREFIX = new Set([
  "{",
  ";",
  "}",
  ",",
  "static",
  "async",
  "get",
  "set",
  "public",
  "private",
  "protected",
  "readonly",
  "abstract",
  "override",
  "*",
]);

/** Words a declaration may be written after: the keyword still starts a statement. */
const DECLARATION_PREFIX = new Set([
  "async",
  "export",
  "default",
  "abstract",
  "declare",
  "static",
  "server",
  "client",
]);

/** Whether a token ends an operand (a literal, a closing bracket, a name). */
function endsOperandToken(token: string): boolean {
  if (token === ")" || token === "]" || token === "}" || token === "lit") {
    return true;
  }
  return isWord(token[0]) && !OPERAND_WORDS.has(token);
}

/**
 * `text` with comments, string contents, regular expressions and the text of
 * template literals replaced by spaces (a `${…}` substitution stays code),
 * every offset unchanged, and what the masking learned about the code.
 */
function mask(text: string): { masked: string; facts: Facts } {
  const facts: Facts = {
    regexEnds: new Set(),
    headEnds: new Set(),
    blockEnds: new Set(),
    braces: [],
  };
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      // A line break stays one: a comment holding it still splits statements.
      if (!isLineBreak(out[k])) out[k] = " ";
    }
  };
  const current = (): string => out.join("");
  // The significant tokens so far (words, punctuation, `lit` for a string,
  // template or regular expression) and where each starts: what a `{` and a
  // `(` are read from, so no brace re-reads the text.
  const toks: string[] = [];
  const tokAt: number[] = [];
  const push = (token: string, at: number): void => {
    toks.push(token);
    tokAt.push(at);
  };
  const last = (back = 0): string => toks[toks.length - 1 - back] ?? "";
  // Open parens: whether each follows an if/for/while/with (`head`), a
  // `switch`/`catch`, and a function or method's parameter list (`body`).
  const parens: {
    head: boolean;
    blockHead: boolean;
    body: { stmt: boolean } | null;
  }[] = [];
  // A `function`/`class` keyword whose body has not opened yet, with the
  // paren depth it was written at and whether it starts a statement.
  let pendingFunction: { depth: number; stmt: boolean } | undefined;
  let pendingBody: { depth: number; stmt: boolean } | undefined;
  let pendingClass: { depth: number; stmt: boolean } | undefined;
  let pendingBlock: number | undefined;
  // Open braces: the kind, and how many `?` still wait for their `:`.
  // The first entry is the statement itself.
  interface Scope {
    readonly kind: ScopeKind;
    ternary: number;
    readonly range: number;
    /** The paren and bracket depth the brace opened at: its own keys sit there. */
    readonly parens: number;
    readonly brackets: number;
  }
  const scopes: Scope[] = [
    { kind: "block", ternary: 0, range: -1, parens: 0, brackets: 0 },
  ];
  const scope = (): Scope => scopes[scopes.length - 1] as Scope;
  let bracketDepth = 0;
  // `<` depth inside a declaration's header (`class A<T extends {}>`).
  let angle = 0;
  // Whether the keyword at token index `k` starts a statement.
  const startsStatement = (k: number): boolean => {
    let j = k - 1;
    while (j >= 0 && DECLARATION_PREFIX.has(toks[j] as string)) {
      if (toks[j] === "export" || toks[j] === "default") return true;
      j--;
    }
    if (j < 0) return true;
    const before = toks[j] as string;
    if (before === ";" || before === "{" || before === "}") return true;
    if (before === "else" || before === "do") return true;
    if (before === ")" && facts.headEnds.has(tokAt[j] as number)) return true;
    // A line break after a token that ends an operand splits the statement.
    return endsOperandToken(before) && lineBreakBefore(out, tokAt[k] as number);
  };
  // What the `{` at `at` opens.
  const kindOfBrace = (): ScopeKind => {
    const here = parens.length;
    const waiting =
      pendingBody?.depth === here ||
      pendingClass?.depth === here ||
      pendingFunction?.depth === here ||
      pendingBlock === here;
    // A type literal in a header (`: { a: 1 }` after the parameters, a type
    // argument) is no body: keep waiting for the body's own `{`.
    if (waiting) {
      const prev = last();
      const typePosition =
        angle > 0 ||
        !(
          prev === "" ||
          isWord(prev[0]) ||
          prev === "lit" ||
          ")]}>".includes(prev)
        );
      if (typePosition) return "object";
    }
    if (pendingBody && pendingBody.depth === parens.length) {
      const body = pendingBody;
      pendingBody = undefined;
      return body.stmt ? "block" : "fnExpr";
    }
    if (pendingClass && pendingClass.depth === parens.length) {
      const body = pendingClass;
      pendingClass = undefined;
      return body.stmt ? "class" : "classExpr";
    }
    if (pendingBlock === parens.length) {
      pendingBlock = undefined;
      return "block";
    }
    const before = last();
    if (before === "") return "block";
    if (before === ";" || before === "{" || before === "}") return "block";
    if (before === ")") return lastParenBlockHead ? "block" : "object";
    if (before === "=>") return "fnExpr";
    if (before === ":") {
      // A label or a `case`'s `:` takes a block; a ternary's or an object
      // key's takes a value.
      const inside = scope();
      return !lastColonTernary && inside.kind === "block" ? "block" : "object";
    }
    if (isWord(before[0])) {
      return EXPRESSION_BRACE_WORDS.has(before) ? "object" : "block";
    }
    return "object";
  };
  let lastParenBlockHead = false;
  let lastColonTernary = false;
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
        push("lit", from);
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
    // A line break that ends a statement ends its pending ternaries too.
    if (
      toks.length > 0 &&
      !isSpace(char) &&
      scope().ternary > 0 &&
      endsOperandToken(last()) &&
      lineBreakBefore(out, i) &&
      !continuesExpression(text, i)
    ) {
      scope().ternary = 0;
    }
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
      push("lit", from);
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
        push("lit", from);
        continue;
      }
      push("/", i);
      i++;
      continue;
    }
    if (isWord(char)) {
      const from = i;
      while (isWord(text[i])) i++;
      const word = text.slice(from, i);
      const afterDot = last() === "." && last(1) !== ".";
      push(word, from);
      if (!afterDot) {
        const k = toks.length - 1;
        if (word === "function") {
          pendingFunction = { depth: parens.length, stmt: startsStatement(k) };
        } else if (word === "class") {
          pendingClass = { depth: parens.length, stmt: startsStatement(k) };
        } else if (
          word === "interface" ||
          word === "enum" ||
          word === "namespace"
        ) {
          pendingBlock = parens.length;
        }
      }
      continue;
    }
    if (char === "(") {
      const before = last();
      const named = isWord(before[0]);
      const head = named && HEAD_WORDS.has(before) && last(1) !== ".";
      let body: { stmt: boolean } | null = null;
      if (pendingFunction && pendingFunction.depth === parens.length) {
        body = { stmt: pendingFunction.stmt };
        pendingFunction = undefined;
      } else if (
        named &&
        (scope().kind === "class" ||
          scope().kind === "classExpr" ||
          scope().kind === "object") &&
        // The name is a key of this brace, not inside a nested `(`/`[`.
        parens.length === scope().parens &&
        bracketDepth === scope().brackets &&
        METHOD_PREFIX.has(last(1))
      ) {
        body = { stmt: true };
      }
      parens.push({
        head,
        blockHead: head || before === "switch" || before === "catch",
        body,
      });
      push("(", i);
    } else if (char === ")") {
      const info = parens.pop();
      if (info?.head === true) facts.headEnds.add(i);
      lastParenBlockHead = info?.blockHead === true;
      // A header whose parens closed below it was a call, not a declaration.
      for (const wait of [pendingFunction, pendingBody, pendingClass]) {
        if (wait && parens.length < wait.depth) {
          if (wait === pendingFunction) pendingFunction = undefined;
          if (wait === pendingBody) pendingBody = undefined;
          if (wait === pendingClass) pendingClass = undefined;
        }
      }
      if (info?.body) {
        pendingBody = { depth: parens.length, stmt: info.body.stmt };
      }
      push(")", i);
    } else if (char === "{") {
      depth++;
      const kind = kindOfBrace();
      facts.braces.push({
        start: i,
        end: Number.POSITIVE_INFINITY,
        cls: kind === "class" || kind === "classExpr",
        parent: scope().range,
      });
      scopes.push({
        kind,
        ternary: 0,
        range: facts.braces.length - 1,
        parens: parens.length,
        brackets: bracketDepth,
      });
      push("{", i);
    } else if (char === "}") {
      if (depth === 0 && braces.length > 0) {
        depth = braces.pop() as number;
        i++;
        template();
        continue;
      }
      depth--;
      const closed = scopes.length > 1 ? scopes.pop() : undefined;
      if (closed) {
        (facts.braces[closed.range] as { end: number }).end = i;
        // A class body's members are no statements: a `}` inside one (a
        // method, a constructor, a `static {}` block) starts none.
        const outer = scope().kind;
        if (
          (closed.kind === "block" || closed.kind === "class") &&
          outer !== "class" &&
          outer !== "classExpr"
        ) {
          facts.blockEnds.add(i);
        }
      }
      push("}", i);
    } else if (char === ";") {
      pendingFunction = pendingBody = pendingClass = undefined;
      pendingBlock = undefined;
      angle = 0;
      scope().ternary = 0;
      push(";", i);
    } else if (
      char === ">" &&
      last() === "=" &&
      tokAt[tokAt.length - 1] === i - 1
    ) {
      toks[toks.length - 1] = "=>";
    } else if (char === "?") {
      // A ternary's `?` waits for its `:`; `?.`, `??` and TypeScript's
      // optional markers (`x?:`, `[T?]`, `m?()`, `f(a?)`) do not.
      let after = i + 1;
      while (isSpace(text[after])) after++;
      const chain = next === "." && !/\d/.test(text[i + 2] ?? "");
      if (next === "?") {
        push("?", i);
        push("?", i + 1);
        i += 2;
        continue;
      }
      if (!chain && !":]),(=;".includes(text[after] ?? ";")) scope().ternary++;
      push("?", i);
    } else if (char === ":") {
      const inside = scope();
      lastColonTernary = inside.ternary > 0;
      if (lastColonTernary) inside.ternary--;
      push(":", i);
    } else if (!isSpace(char)) {
      if (char === "[") bracketDepth++;
      else if (char === "]" && bracketDepth > 0) bracketDepth--;
      else if (char === "<" && (pendingClass || pendingFunction || pendingBody))
        angle++;
      else if (char === ">" && angle > 0) angle--;
      else if (
        char === "," &&
        angle === 0 &&
        pendingBody?.depth === parens.length
      )
        pendingBody = undefined;
      push(char, i);
    }
    i++;
  }
  return { masked: current(), facts };
}

/**
 * Whether what follows an `@name` at `end` makes it a TypeScript decorator
 * (`@dec class B {}`, `@dec @other export class`, `@dec(args) class`), not a
 * row: another decorator, or `class`/`export`/`abstract`/`default`.
 */
function isDecorator(masked: string, end: number): boolean {
  let j = end;
  while (isSpace(masked[j])) j++;
  if (masked[j] === "(") {
    let level = 0;
    for (; j < masked.length; j++) {
      if (masked[j] === "(") level++;
      else if (masked[j] === ")" && --level === 0) {
        j++;
        break;
      }
    }
    while (isSpace(masked[j])) j++;
  }
  return (
    masked[j] === "@" ||
    /^(class|export|abstract|default)(?![\p{L}\p{N}_$])/u.test(
      masked.slice(j, j + 9),
    )
  );
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
          !(armed.row.chars.includes("@") && isDecorator(masked, end)) &&
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
