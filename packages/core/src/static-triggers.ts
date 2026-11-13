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
 * and the token does not continue past the match, by an identifier
 * character or by non-ASCII word characters the matcher stops short of
 * (the parser's `stopsShortOfToken`: `~a-é` under an ASCII matcher).
 *
 * Whether a candidate is a row is Babel's to say, not a statement grammar
 * of this file's: the statement is parsed as `rejectInvalidStatement` parses
 * it (its one block's braces blanked, `statementParseOptions` for its
 * keyword), except that placement of `import`/`export` is allowed, so a
 * misplaced import does not hide a row (the statement check still reports
 * the placement when no row is found), and a candidate is a row
 * where an expression starts at its first character: the innermost node
 * starting there is an expression, a referenced one when it is an
 * identifier (Babel's `isReferenced`, or an assignment's target; under a
 * TypeScript parent only an `expression`, an enum initializer or a computed
 * key), and not inside a TypeScript type. A unary `~zz` at a statement
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
 * The row's node type is then asked whether it claims a candidate Babel
 * decided is a row, as the template's `claim` asks it
 * (`refuseRowInModuleStatement` passes the question): a declined candidate
 * is plain source, and the rest are decided again without it.
 *
 * Where it differs from the template: a private name the
 * class does not declare (`#x in this` with no `#x` member) does not parse
 * as written, so it reads as its stand-in and is found as a row; so does a
 * decorator on its own line (`@dec⏎class B {}`), whose stand-in parses as an
 * expression statement or a member, so it is reported as a row instead of
 * the decorator refusal.
 */
import type { ParserOptions } from "@babel/parser";
import { standInText, stopsShortOfToken } from "@mxlang/parser/lexer";
import { coreBabel, coreParser } from "./babel.ts";
import {
  blankBlock,
  type StatementBlock,
  statementBlock,
} from "./statement-block.ts";
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
              text[end] === ".") ||
            stopsShortOfToken(armed.matcher, text, i, end));
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

/**
 * `text` parsed as the statement check parses it, or `undefined` when Babel
 * refuses it. `block` is the statement's one block, read once from the text
 * as written (`statementBlock`): its braces are blanked, as
 * `blankStatementBlock` does, and a stand-in keeps every offset, so the
 * braces sit at the same offsets in every variant. Any other throw (a broken
 * parser) is not a parse failure and propagates.
 */
function parseStatement(
  text: string,
  keyword: string,
  block: StatementBlock | undefined,
): Ast | undefined {
  const code = block ? blankBlock(text, block) : text;
  const options = {
    ...statementParseOptions(keyword),
    allowImportExportEverywhere: true,
  } satisfies ParserOptions;
  try {
    return coreParser().parse(code, options) as unknown as Ast;
  } catch (error) {
    if (isParseFailure(error)) return undefined;
    throw error;
  }
}

/**
 * Babel's own refusal of the text (`BABEL_PARSER_SYNTAX_ERROR`, …), or its
 * parser running out of stack on a deeply nested text (a `RangeError`): the
 * statement check reads the same text and reports that as its error.
 */
function isParseFailure(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return (
    error instanceof SyntaxError &&
    typeof code === "string" &&
    code.startsWith("BABEL_PARSER_")
  );
}

/**
 * Whether an identifier under a TypeScript parent is a reference. Babel's
 * `isReferenced` answers `true` for a parent it does not list, which is
 * every TypeScript declaration, signature and parameter (`interface I {}`,
 * `declare function f(a: T): void`, `import a = N.b`). Under a `TS*` parent
 * an identifier is a reference only as the parent's `expression` (`x as T`,
 * `x satisfies T`, `x!`, `<T>x`, `f<T>`, `export = x`), an enum member's
 * `initializer`, or a `computed` key.
 */
function isTsReference(node: Ast, parent: Ast): boolean {
  if (parent.expression === node) return true;
  if (parent.type === "TSEnumMember") return parent.initializer === node;
  return parent.key === node && parent.computed === true;
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
 * The offsets of `wanted` where an expression starts in `file` (the row
 * predicate): an innermost node starting there is an expression, not a
 * non-computed key, a referenced identifier when it is one, and no
 * ancestor is a TypeScript type.
 */
function rowStarts(file: Ast, wanted: ReadonlySet<number>): Set<number> {
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
    const parent = ancestors[ancestors.length - 1];
    // A non-computed key names a member, whatever node the key is (an
    // identifier, or a numeric or string literal stand-in).
    if (parent?.key === node && parent.computed !== true) return false;
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
      const grandparent = ancestors[ancestors.length - 2];
      if (parent?.type.startsWith("TS") && !isTsReference(node, parent)) {
        return false;
      }
      return (
        t.isReferenced(node, parent, grandparent) ||
        isAssignmentTarget(node, ancestors)
      );
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
  // One walk over the tree. A node is innermost at its start when no child
  // starts there too (a shorthand property's key and value both are, and
  // the predicate holds when it holds on one). The walk keeps its own stack
  // and one ancestor chain, so a deep expression costs no call depth.
  interface Frame {
    readonly node: Ast;
    readonly kids: Ast[];
    next: number;
  }
  const frame = (node: Ast): Frame => ({ node, kids: children(node), next: 0 });
  const found = new Set<number>();
  const ancestors: Ast[] = [];
  const frames: Frame[] = [frame(file)];
  while (frames.length > 0) {
    const top = frames[frames.length - 1] as Frame;
    const child = top.kids[top.next++];
    if (child) {
      ancestors.push(top.node);
      frames.push(frame(child));
      continue;
    }
    // Every child read: `ancestors` is still this node's chain.
    frames.pop();
    const start = top.node.start as number;
    if (
      wanted.has(start) &&
      !found.has(start) &&
      !top.kids.some((kid) => kid.start === start) &&
      holds(top.node, ancestors)
    ) {
      found.add(start);
    }
    ancestors.pop();
  }
  return found;
}

/**
 * Whether `node` is written to by an assignment (`x = 1`, `x += 1`,
 * `[a, b] = xs`, `({ a } = o)`, `for (x of xs)`): Babel's `isReferenced`
 * says no there, and its `isBinding` says yes for a declaration and an
 * assignment alike. The pattern ancestors are climbed to the nearest
 * non-pattern node, which is an assignment's or a `for … in/of` head's
 * `left` (not a declaration's) for an assignment target; a declaration's
 * pattern ends at a declarator, a parameter list or a catch clause.
 */
function isAssignmentTarget(node: Ast, ancestors: readonly Ast[]): boolean {
  let child = node;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const parent = ancestors[i] as Ast;
    switch (parent.type) {
      case "ArrayPattern":
      case "ObjectPattern":
      case "RestElement":
        break;
      case "ObjectProperty":
        // A property's value inside an object pattern.
        if (
          parent.value !== child ||
          ancestors[i - 1]?.type !== "ObjectPattern"
        )
          return false;
        break;
      case "AssignmentPattern":
        if (parent.left !== child) return false;
        break;
      case "AssignmentExpression":
        return parent.left === child;
      case "ForInStatement":
      case "ForOfStatement":
        return parent.left === child;
      default:
        return false;
    }
    child = parent;
  }
  return false;
}

/** `text` with each hit in `hits` replaced by its stand-in (same length). */
function withStandIns(text: string, hits: readonly StatementHit[]): string {
  let out = "";
  let from = 0;
  for (const hit of hits) {
    // A hit inside one already replaced (a match that holds another row's
    // first character) is part of that stand-in.
    if (hit.start < from) continue;
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
 * `claims`, when given, is asked whether a candidate Babel decided is a row
 * is claimed by the row's node type (the template's `claim`): a declined
 * candidate is removed and the rest decided again, its text then staying
 * source in every variant, so it is asked at most once per start and never
 * for a candidate Babel does not read as a row (a comment, a string).
 */
export function firstRowIn(
  text: string,
  rows: readonly Trigger[],
  keyword = "static",
  claims?: (hit: StatementHit) => boolean,
): StatementHit | undefined {
  const compiled = compile(rows);
  if (compiled.length === 0) return undefined;
  let candidates = candidatesIn(text, compiled);
  // A statement with no mark costs no parse.
  if (candidates.length === 0) return undefined;
  // The one block's braces, read once from the text as written.
  const block = statementBlock(text);
  const written = parseStatement(text, keyword, block);
  for (;;) {
    const hit = decide(text, candidates, keyword, block, written);
    if (!hit || !claims || claims(hit)) return hit;
    candidates = candidates.filter((each) => each !== hit);
  }
}

/**
 * The first of `candidates` that is a row (`firstRowIn`). `written` is the
 * text as written parsed, or `undefined` when Babel refuses it.
 */
function decide(
  text: string,
  candidates: readonly StatementHit[],
  keyword: string,
  block: StatementBlock | undefined,
  written: Ast | undefined,
): StatementHit | undefined {
  if (written) {
    // Valid TypeScript: its own reading decides every candidate.
    const starts = rowStarts(
      written,
      new Set(candidates.map((each) => each.start)),
    );
    return candidates.find((each) => starts.has(each.start));
  }
  for (const [index, candidate] of candidates.entries()) {
    const later = candidates.slice(index + 1);
    // Earlier candidates stay as written: they were judged not to be rows
    // (or their row was declined). Every candidate as written is the text
    // itself, which did not parse, so that variant is not tried again.
    // A variant equal to one already read (the last candidate's second and
    // third, or any variant of a `keep` stand-in) is not parsed again.
    const tried = new Set([text]);
    for (const replaced of [later, [candidate, ...later], [candidate]]) {
      const variant = withStandIns(text, replaced);
      if (tried.has(variant)) continue;
      tried.add(variant);
      const file = parseStatement(variant, keyword, block);
      if (!file) continue;
      if (rowStarts(file, new Set([candidate.start])).size > 0) {
        return candidate;
      }
      break;
    }
  }
  return undefined;
}
