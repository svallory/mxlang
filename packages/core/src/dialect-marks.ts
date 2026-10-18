/**
 * The marking characters of a dialect's syntax table, and the check that no
 * two dialects installed in one project share one. A row's mark is what
 * starts the forms it claims: the literal text its `match` starts with (the
 * `%.` of `%\.name`), or, when `match` starts with a class or a group, the
 * characters of its `chars`. Two marks overlap when one is a prefix of the
 * other (`%` and `%.`), or when their character sets share a character.
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

/** The literal text `match` (a regular expression source) must start with. */
function literalPrefix(match: string): string {
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
    for (const row of (table[list] ?? []) as readonly Trigger[]) {
      if (typeof row?.chars !== "string" || typeof row.match !== "string") {
        continue;
      }
      const prefix = literalPrefix(row.match);
      marks.push({
        row: row.id,
        list,
        prefix,
        ranges: prefix === "" ? rangesOf(row.chars) : [],
      });
    }
  }
  return marks;
}

const hasCode = (mark: Mark, code: number): boolean =>
  mark.ranges.some(([from, to]) => code >= from && code <= to);

function overlap(a: Mark, b: Mark): string | undefined {
  if (a.prefix !== "" && b.prefix !== "") {
    return a.prefix.startsWith(b.prefix)
      ? b.prefix
      : b.prefix.startsWith(a.prefix)
        ? a.prefix
        : undefined;
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
