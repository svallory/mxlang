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
 * Candidates follow the template scanner (the parser's `lexTrigger`): a
 * first character arms one row (a `chars` set is compared by that
 * character), the row's `match` must match there with a non-empty text, the
 * text is not inside a word or right after the same character (`a &&b`),
 * and the token does not continue past the match.
 *
 * Whether a candidate is a row is Babel's to say, not a statement grammar
 * of this file's: the statement is parsed as `rejectInvalidStatement` parses
 * it (its one block's braces blanked, `statementParseOptions` for its
 * keyword, placement of `import`/`export` allowed), and a candidate is a row
 * where an expression starts at its first character: the innermost node
 * starting there is an expression, a referenced one when it is an
 * identifier, and not inside a TypeScript type. A unary `~zz` at a statement
 * start (after a block's `}`, after a line break that ends a statement) is
 * one; a binary operator (`a\n&mask`), a private name, a type, an object key
 * and a binding are not. Comments, strings, regular expressions and
 * template-literal text hold no expression start, so a candidate there is
 * never a row.
 *
 * The text as written is read first, and when it parses its reading wins.
 * When it does not (the row is not JavaScript there, `= &zz`), each
 * candidate in order is read with its matched text replaced by the
 * template's stand-in (`standInText`, same length, so no offset moves),
 * trying the later candidates as stand-ins first and as written second; the
 * first variant that parses decides that candidate. A statement no variant
 * parses has no row error, and `rejectInvalidStatement` reports Babel's own
 * positioned error.
 *
 * Where it differs from the template: the parser's `claim` hook and its
 * non-ASCII `stopsShortOfToken` decline are not applied.
 */
import { standInText } from "@mxlang/parser/lexer";
import { coreBabel, coreParser } from "./babel.ts";
import { blankStatementBlock } from "./statement-block.ts";
import { statementParseOptions } from "./statement-parse-options.ts";
import type { Trigger } from "./syntax-table.ts";

/** A row the statement's text matched: its offset in the statement and its text. */
export interface StatementHit {
  readonly row: Trigger;
  readonly start: number;
  readonly end: number;
}

const WORD = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]/u;
const isWord = (char: string | undefined): boolean =>
  char !== undefined && WORD.test(char);

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

/** The candidates in `text`: where a row's match stands, by the template's rules. */
function candidatesIn(
  text: string,
  compiled: readonly Compiled[],
): StatementHit[] {
  const out: StatementHit[] = [];
  let i = 0;
  while (i < text.length) {
    const point = String.fromCodePoint(text.codePointAt(i) as number);
    const armed = compiled.find((each) => each.first.test(point));
    if (armed) {
      armed.matcher.lastIndex = i;
      const found = armed.matcher.exec(text);
      if (found !== null && found[0].length > 0) {
        const end = i + found[0].length;
        const { standIn } = armed.row;
        const continues =
          standIn !== "keep" &&
          (isWord(text[end]) ||
            (standIn === "number" &&
              found[0].length === 1 &&
              text[end] === "."));
        if (
          !continues &&
          !(i > 0 && isWord(text[i - 1])) &&
          !(i > 0 && text[i - 1] === text[i])
        ) {
          out.push({ row: armed.row, start: i, end });
        }
      }
    }
    i += point.length;
  }
  return out;
}

type Ast = Record<string, unknown> & { type: string; start?: number };

/** `text` parsed as the statement check parses it, or `undefined` when it does not parse. */
function parseStatement(text: string, keyword: string): Ast | undefined {
  try {
    return coreParser().parse(blankStatementBlock(text), {
      ...statementParseOptions(keyword),
      allowImportExportEverywhere: true,
    } as never) as unknown as Ast;
  } catch {
    return undefined;
  }
}

const isNode = (value: unknown): value is Ast =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

/** Fields of a node that hold no child of the program. */
const SKIPPED = new Set([
  "loc",
  "extra",
  "comments",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "tokens",
  "errors",
]);

/**
 * Whether an expression starts at `at` in `file` (the row predicate): the
 * innermost node starting there is an expression, a referenced identifier
 * when it is one, and no ancestor is a TypeScript type.
 */
function expressionStartsAt(file: Ast, at: number): boolean {
  const t = coreBabel().types as {
    isExpression(node: unknown): boolean;
    isReferenced(
      node: unknown,
      parent: unknown,
      grandparent?: unknown,
    ): boolean;
    isTSType(node: unknown): boolean;
  };
  const holds = (node: Ast, ancestors: readonly Ast[]): boolean => {
    if (!t.isExpression(node)) return false;
    if (
      ancestors.some(
        (each) =>
          t.isTSType(each) ||
          each.type === "TSTypeAnnotation" ||
          each.type === "TSTypeParameterInstantiation",
      )
    ) {
      return false;
    }
    if (node.type === "Identifier") {
      const parent = ancestors[ancestors.length - 1];
      const grandparent = ancestors[ancestors.length - 2];
      return t.isReferenced(node, parent, grandparent);
    }
    return true;
  };
  const children = (node: Ast): Ast[] => {
    const out: Ast[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (SKIPPED.has(key)) continue;
      if (Array.isArray(value)) {
        for (const each of value) if (isNode(each)) out.push(each);
      } else if (isNode(value)) out.push(value);
    }
    return out;
  };
  // Every innermost node starting at `at` (a shorthand property's key and
  // value both start there): the predicate holds when it holds on one.
  const visit = (node: Ast, ancestors: Ast[]): boolean => {
    const chain = [...ancestors, node];
    let inner = false;
    for (const child of children(node)) {
      const start = child.start as number;
      const end = child.end as number;
      if (start > at || end <= at) continue;
      if (start === at) inner = true;
      if (visit(child, chain)) return true;
    }
    return !inner && node.start === at && holds(node, ancestors);
  };
  return visit(file, []);
}

/** `text` with each hit in `hits` replaced by its stand-in (same length). */
function withStandIns(text: string, hits: readonly StatementHit[]): string {
  let out = "";
  let from = 0;
  for (const hit of hits) {
    out +=
      text.slice(from, hit.start) +
      standInText(hit.row.standIn, text.slice(hit.start, hit.end));
    from = hit.end;
  }
  return out + text.slice(from);
}

/**
 * The first dialect expression row `text` (a `keyword` statement's text, as
 * the statement check parses it) writes where an expression starts, if any.
 */
export function firstRowIn(
  text: string,
  rows: readonly Trigger[],
  keyword = "static",
): StatementHit | undefined {
  const compiled = compile(rows);
  if (compiled.length === 0) return undefined;
  const candidates = candidatesIn(text, compiled);
  // A statement with no mark costs no parse.
  if (candidates.length === 0) return undefined;
  const written = parseStatement(text, keyword);
  if (written) {
    // Valid TypeScript: its own reading decides every candidate.
    return candidates.find((each) => expressionStartsAt(written, each.start));
  }
  for (const [index, candidate] of candidates.entries()) {
    const later = candidates.slice(index + 1);
    // Earlier candidates stay as written: they were judged not to be rows.
    for (const replaced of [later, [candidate, ...later], [], [candidate]]) {
      const file = parseStatement(withStandIns(text, replaced), keyword);
      if (!file) continue;
      if (expressionStartsAt(file, candidate.start)) return candidate;
      break;
    }
  }
  return undefined;
}
