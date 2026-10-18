/**
 * The marking characters of a dialect's syntax table, and the check that no
 * two dialects installed in one project share one. A row's mark is what
 * starts the forms it claims: the literal text its `match` starts with (the
 * `%.` of `%\.name`), or, when `match` starts with a class or a group, the
 * characters of its `chars`. Two marks clash only when they are identical:
 * the same literal text, or character sets sharing a character, or a
 * one-character literal inside a set. A prefix is no clash (`%` and `%.`
 * may both be installed): the dialects' tables never meet in one scanner, and
 * within one table a first character arms one row.
 * Core reads no dialect's own vocabulary here: it compares the table rows.
 */
import type { SyntaxTable, Trigger } from "./syntax-table.ts";

/** The table lists that hold rows. */
const ROW_LISTS = [
  "expressionTriggers",
  "attributeTriggers",
  "lineTriggers",
  "valueTriggers",
  "textTriggers",
] as const;

/** A row's mark: a literal prefix, or the characters (as code point ranges) that start it. */
interface Mark {
  readonly row: string;
  readonly list: string;
  readonly index: number;
  readonly prefix: string;
  readonly ranges: readonly (readonly [number, number])[];
}

/** One clash: the rows of both dialects and the text they share. */
export interface MarkOverlap {
  readonly mark: string;
  readonly first: { readonly row: string; readonly list: string };
  readonly second: { readonly row: string; readonly list: string };
}

/** The characters `chars` (the inside of a `[...]` class) spells, as code point ranges. */
function rangesOf(chars: string): (readonly [number, number])[] {
  const points = [...chars];
  const ranges: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    let char = points[i] as string;
    if (char === "\\" && i + 1 < points.length) char = points[++i] as string;
    const code = char.codePointAt(0) as number;
    if (points[i + 1] === "-" && i + 2 < points.length) {
      let end = points[i + 2] as string;
      i += 2;
      if (end === "\\" && i + 1 < points.length) end = points[++i] as string;
      ranges.push([code, end.codePointAt(0) as number]);
    } else {
      ranges.push([code, code]);
    }
  }
  return ranges;
}

/** `match` split at its top-level `|` (outside groups, classes and escapes). */
function alternatives(match: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let current = "";
  for (let i = 0; i < match.length; i++) {
    const char = match[i] as string;
    if (char === "\\") {
      current += char + (match[++i] ?? "");
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") inClass = true;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "|" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * The literal text `match` (a regular expression source) must start with:
 * for top-level alternatives, the longest prefix they all share.
 */
function literalPrefix(match: string): string {
  const parts = alternatives(match).map(alternativePrefix);
  return parts.reduce((common, each) => {
    let n = 0;
    while (n < common.length && n < each.length && common[n] === each[n]) n++;
    return common.slice(0, n);
  });
}

function alternativePrefix(match: string): string {
  const points = [...match];
  let out = "";
  let i = 0;
  if (points[0] === "^") i++;
  while (i < points.length) {
    const char = points[i] as string;
    let literal: string;
    let width = 1;
    if (char === "\\") {
      const next = points[i + 1];
      if (next === undefined || /[A-Za-z0-9]/.test(next)) break;
      literal = next;
      width = 2;
    } else if ("[](){}|.*+?^$".includes(char)) {
      break;
    } else {
      literal = char;
    }
    const after = points[i + width];
    // A literal that may repeat zero times is not part of the prefix.
    if (after === "?" || after === "*" || after === "{") break;
    out += literal;
    i += width;
  }
  return out;
}

function marksOf(table: Partial<SyntaxTable> | undefined): Mark[] {
  const marks: Mark[] = [];
  if (!table) return marks;
  for (const list of ROW_LISTS) {
    const rows = (table[list] ?? []) as readonly Trigger[];
    for (const [index, row] of rows.entries()) {
      if (typeof row?.chars !== "string" || typeof row.match !== "string") {
        continue;
      }
      const prefix = literalPrefix(row.match);
      marks.push({
        row: row.id,
        list,
        index,
        prefix,
        ranges: prefix === "" ? rangesOf(row.chars) : [],
      });
    }
  }
  return marks;
}

const hasCode = (mark: Mark, code: number): boolean =>
  mark.ranges.some(([from, to]) => code >= from && code <= to);

/**
 * The text two marks share when they are identical, else `undefined`. Two
 * literals are identical when equal; two character sets when they share a
 * character; a literal and a set when the literal is one character of the
 * set (a longer literal only has the set's character as a prefix, and a
 * prefix is no clash).
 */
function overlap(a: Mark, b: Mark): string | undefined {
  if (a.prefix !== "" && b.prefix !== "") {
    return a.prefix === b.prefix ? a.prefix : undefined;
  }
  if (a.prefix === "" && b.prefix === "") {
    for (const [from, to] of a.ranges) {
      for (const [from2, to2] of b.ranges) {
        const low = Math.max(from, from2);
        if (low <= Math.min(to, to2)) return String.fromCodePoint(low);
      }
    }
    return undefined;
  }
  const [prefixed, set] = a.prefix !== "" ? [a, b] : [b, a];
  const points = [...prefixed.prefix];
  if (points.length !== 1) return undefined;
  return hasCode(set, points[0]?.codePointAt(0) as number)
    ? prefixed.prefix
    : undefined;
}

/**
 * The text two marks share when one equals, is a prefix of, or has as a
 * prefix the other: how core's own marks are compared, since core reads
 * that text itself before any row is tried.
 */
function sharedText(a: Mark, b: Mark): string | undefined {
  if (a.prefix !== "" && b.prefix !== "") {
    return a.prefix.startsWith(b.prefix)
      ? b.prefix
      : b.prefix.startsWith(a.prefix)
        ? a.prefix
        : undefined;
  }
  if (a.prefix === "" && b.prefix === "") return overlap(a, b);
  const [prefixed, set] = a.prefix !== "" ? [a, b] : [b, a];
  const first = prefixed.prefix.codePointAt(0) as number;
  return hasCode(set, first) ? String.fromCodePoint(first) : undefined;
}

/**
 * The first mark both tables claim, or `undefined` when their marks are
 * disjoint.
 */
export function findMarkOverlap(
  first: Partial<SyntaxTable> | undefined,
  second: Partial<SyntaxTable> | undefined,
): MarkOverlap | undefined {
  const others = marksOf(second);
  for (const a of marksOf(first)) {
    for (const b of others) {
      const mark = overlap(a, b);
      if (mark !== undefined) {
        return {
          mark,
          first: { row: a.row, list: a.list },
          second: { row: b.row, list: b.list },
        };
      }
    }
  }
  return undefined;
}

/**
 * What the parser itself reads at the start of a name in the attribute list,
 * before any row is tried: a spread (`...`) and a tag's parameters (`|`).
 * (`<`, `>`, `/`, `=`, `,`, `;`, brackets and whitespace are refused as a
 * row's first character already; `:=` binds only when `=` follows, so a row
 * marked `:` still arms.) A row marked with one of these never fires.
 */
const CORE_MARKS: Readonly<
  Record<string, readonly { mark: string; what: string }[]>
> = {
  attributeTriggers: [
    { mark: "...", what: "a spread" },
    { mark: "|", what: "a tag's parameters" },
  ],
};

/** A row that starts with text the parser reads itself. */
export interface CoreMarkClash {
  readonly list: string;
  readonly index: number;
  readonly row: string;
  readonly mark: string;
  readonly coreMark: string;
  readonly what: string;
}

/**
 * The first row of `table` whose mark equals, is a prefix of, or has as a
 * prefix a mark core claims in that position, or `undefined`.
 */
export function findCoreMarkClash(
  table: Partial<SyntaxTable> | undefined,
): CoreMarkClash | undefined {
  for (const own of marksOf(table)) {
    for (const core of CORE_MARKS[own.list] ?? []) {
      const mark = sharedText(own, {
        row: "",
        list: own.list,
        index: -1,
        prefix: core.mark,
        ranges: [],
      });
      if (mark !== undefined) {
        return {
          list: own.list,
          index: own.index,
          row: own.row,
          mark,
          coreMark: core.mark,
          what: core.what,
        };
      }
    }
  }
  return undefined;
}
