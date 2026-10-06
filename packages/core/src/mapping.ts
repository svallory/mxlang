import { parseExpression } from "@babel/parser";
import type { Expr } from "./ir.ts";

/**
 * A half-open `[sourceStart, sourceEnd)` range in an MX source file, in UTF-16
 * code units (JS string indexes), file-absolute.
 */
export interface SourceSpan {
  sourceStart: number;
  sourceEnd: number;
}

/** One unchanged source name written into generated host code. */
export interface GeneratedMapping extends SourceSpan {
  generatedStart: number;
  generatedEnd: number;
}

/** Generated text plus mappings whose generated offsets are relative to it. */
export interface MappedCode {
  code: string;
  mappings: GeneratedMapping[];
}

/** Concatenates generated fragments while rebasing every fragment's mappings. */
export function concatMapped(...parts: Array<string | MappedCode>): MappedCode {
  let code = "";
  const mappings: GeneratedMapping[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      code += part;
      continue;
    }
    const offset = code.length;
    code += part.code;
    mappings.push(
      ...part.mappings.map((mapping) => ({
        ...mapping,
        generatedStart: mapping.generatedStart + offset,
        generatedEnd: mapping.generatedEnd + offset,
      })),
    );
  }
  return { code, mappings };
}

/** Creates a fragment whose complete generated text maps to a source span. */
export function mapped(code: string, span: SourceSpan | null): MappedCode {
  return {
    code,
    mappings: span
      ? [
          {
            ...span,
            generatedStart: 0,
            generatedEnd: code.length,
          },
        ]
      : [],
  };
}

/**
 * The sibling of `mapped(name, nameSpan)` for the other half of the mapped
 * population. Unmapped when the expression has no authored source (a
 * synthesized `Expr`, or a fabricated literal default).
 */
export function mappedExpr(expr: Expr): MappedCode {
  return (
    atomMappings(expr) ??
    rewrittenMappings(expr) ??
    mapped(expr.code, expr.span ?? null)
  );
}

/**
 * An expression whose reads were rewritten (`i` to `i()`) has `code` of a
 * different length than its authored text, so one whole-span mapping would
 * shift every position after the first rewrite. The tokens `code` kept map
 * to the tokens they came from one to one, and text a rewrite put in place
 * of an authored token maps as a whole to that token. Text a rewrite only
 * inserted stays unmapped. `undefined` when nothing was rewritten.
 */
function rewrittenMappings(expr: Expr): MappedCode | undefined {
  const before = expr.unrewrittenCode;
  const span = expr.span;
  if (before === undefined || !span || before === expr.code) return undefined;
  // `before` against the authored text: atoms (one character longer) or a
  // whole-span identity.
  const base =
    atomMappings({ ...expr, code: before }) ??
    mapped(
      before,
      span.sourceEnd - span.sourceStart === before.length ? span : null,
    );
  return mapTokenDiff(base, expr.code);
}

/**
 * `after` is `base.code` reprinted or rewritten. Its unchanged tokens map to
 * the source one to one and a changed run maps as a whole to the authored
 * run it replaced, so the positions after a change do not shift. Used for a
 * method body the printer reformatted (`{ go() }` printed as `{ go(); }`) as
 * well as for rewritten reads.
 */
export function mappedRewrite(
  after: string,
  before: string,
  span: SourceSpan,
): MappedCode {
  if (after === before) return mapped(after, span);
  return mapTokenDiff(mapped(before, span), after);
}

/**
 * Where the body of a printed method starts: `code` is the `function`
 * expression the compiler printed for an attribute method shorthand
 * (`onClick() { … }` as `function () { … }`), and the parsed function's own
 * body position splits it (a body may hold its own `) {`). `null` when `code`
 * is not one function expression.
 */
function printedBodyStart(code: string): number | null {
  let fn: ReturnType<typeof parseExpression>;
  try {
    fn = parseExpression(code, { plugins: ["typescript"] });
  } catch {
    return null;
  }
  if (fn?.type !== "FunctionExpression" || fn.end !== code.length) return null;
  return fn.body.start ?? null;
}

/**
 * The text and mapping of an attribute method shorthand (`onClick() { … }`),
 * emitted as the `function` expression the compiler printed for it: the
 * printed head is generated text and stays unmapped, the body maps token by
 * token against the authored body (`Expr.bodySpan`/`bodySource`), also when
 * the printer reformatted it or reads were rewritten. `undefined` when `expr`
 * is not a method shorthand, so the caller maps it as any other expression.
 */
export function mappedMethod(expr: Expr): MappedCode | undefined {
  const { bodySpan, bodySource } = expr;
  if (!bodySpan || bodySource === undefined) return undefined;
  const at = printedBodyStart(expr.code);
  if (at === null) return { code: expr.code, mappings: [] };
  return concatMapped(
    mapped(expr.code.slice(0, at), null),
    mappedRewrite(expr.code.slice(at), bodySource, bodySpan),
  );
}

function mapTokenDiff(base: MappedCode, after: string): MappedCode {
  const before = base.code;
  const toSource = (start: number, end: number): GeneratedMapping[] => {
    const out: GeneratedMapping[] = [];
    for (const piece of base.mappings) {
      const from = Math.max(start, piece.generatedStart);
      const to = Math.min(end, piece.generatedEnd);
      if (to <= from) continue;
      const wholePiece =
        piece.generatedEnd - piece.generatedStart ===
        piece.sourceEnd - piece.sourceStart;
      out.push({
        sourceStart: wholePiece
          ? piece.sourceStart + (from - piece.generatedStart)
          : piece.sourceStart,
        sourceEnd: wholePiece
          ? piece.sourceStart + (to - piece.generatedStart)
          : piece.sourceEnd,
        generatedStart: from,
        generatedEnd: to,
      });
    }
    return out;
  };
  const oldTokens = tokenize(before);
  const newTokens = tokenize(after);
  const mappings: GeneratedMapping[] = [];
  // A kept token maps one to one; a replaced run maps as a whole.
  const emit = (
    oldStart: number,
    oldEnd: number,
    newStart: number,
    newEnd: number,
    verbatim: boolean,
  ) => {
    const pieces = toSource(oldStart, oldEnd);
    if (verbatim) {
      for (const piece of pieces) {
        mappings.push({
          ...piece,
          generatedStart: piece.generatedStart + newStart - oldStart,
          generatedEnd: piece.generatedEnd + newStart - oldStart,
        });
      }
      return;
    }
    const first = pieces[0];
    const last = pieces[pieces.length - 1];
    if (!first || !last) return;
    mappings.push({
      sourceStart: first.sourceStart,
      sourceEnd: last.sourceEnd,
      generatedStart: newStart,
      generatedEnd: newEnd,
    });
  };
  // A replaced run keeps its authored name as one span.
  const emitGap = (
    oldFrom: number,
    oldTo: number,
    newFrom: number,
    newTo: number,
  ) => {
    const oldFirst = oldTokens[oldFrom];
    const oldLast = oldTokens[oldTo - 1];
    const newFirst = newTokens[newFrom];
    const newLast = newTokens[newTo - 1];
    if (!oldFirst || !oldLast || !newFirst || !newLast) return;
    emit(oldFirst.start, oldLast.end, newFirst.start, newLast.end, false);
  };
  let i = 0;
  let j = 0;
  for (const [matchOld, matchNew] of matchTokens(oldTokens, newTokens)) {
    if (matchOld > i || matchNew > j) emitGap(i, matchOld, j, matchNew);
    const a = oldTokens[matchOld];
    const b = newTokens[matchNew];
    if (a && b) emit(a.start, a.end, b.start, b.end, true);
    i = matchOld + 1;
    j = matchNew + 1;
  }
  if (i < oldTokens.length || j < newTokens.length) {
    emitGap(i, oldTokens.length, j, newTokens.length);
  }
  return { code: after, mappings: mergeAdjacent(mappings) };
}

/**
 * The middle of the token diff, after the common prefix and suffix are
 * trimmed, is a longest-common-subsequence table of `old x new` cells. Past
 * this many cells (about 2000 x 2000 tokens, whitespace runs included) the
 * middle is not diffed: it maps as one replaced run, so a very large rewritten
 * expression loses its per-token columns between its first and last change
 * but never stalls the editor. Everything before the first change and after
 * the last one stays exact.
 */
export const MAX_DIFF_CELLS = 4_000_000;

/** Index pairs of the tokens the two sequences keep, in order. */
function matchTokens(
  oldTokens: Token[],
  newTokens: Token[],
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let prefix = 0;
  const shortest = Math.min(oldTokens.length, newTokens.length);
  while (
    prefix < shortest &&
    oldTokens[prefix]?.text === newTokens[prefix]?.text
  ) {
    pairs.push([prefix, prefix]);
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    oldTokens[oldTokens.length - 1 - suffix]?.text ===
      newTokens[newTokens.length - 1 - suffix]?.text
  ) {
    suffix++;
  }
  const oldEnd = oldTokens.length - suffix;
  const newEnd = newTokens.length - suffix;
  const rows = oldEnd - prefix + 1;
  const cols = newEnd - prefix + 1;
  if (rows * cols <= MAX_DIFF_CELLS) {
    // Longest common subsequence of the middle.
    const table = new Uint32Array(rows * cols);
    for (let i = rows - 2; i >= 0; i--) {
      for (let j = cols - 2; j >= 0; j--) {
        table[i * cols + j] =
          oldTokens[prefix + i]?.text === newTokens[prefix + j]?.text
            ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
            : Math.max(
                table[(i + 1) * cols + j] ?? 0,
                table[i * cols + j + 1] ?? 0,
              );
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows - 1 && j < cols - 1) {
      if (oldTokens[prefix + i]?.text === newTokens[prefix + j]?.text) {
        pairs.push([prefix + i, prefix + j]);
        i++;
        j++;
      } else if (
        (table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)
      ) {
        i++;
      } else {
        j++;
      }
    }
  }
  for (let k = suffix; k > 0; k--) {
    pairs.push([oldTokens.length - k, newTokens.length - k]);
  }
  return pairs;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

/** Identifiers/numbers, whitespace runs, strings, and single punctuation. */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[\p{ID_Continue}$]+|\s+|./gsu;
  for (const match of code.matchAll(pattern)) {
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

/**
 * Joins verbatim mappings that touch in both generated and source offsets. A
 * replaced run (different lengths) stays apart, or the text after it would
 * shift by the length difference.
 */
function mergeAdjacent(mappings: GeneratedMapping[]): GeneratedMapping[] {
  const out: GeneratedMapping[] = [];
  for (const mapping of mappings) {
    const last = out[out.length - 1];
    const verbatim = (piece: GeneratedMapping) =>
      piece.generatedEnd - piece.generatedStart ===
      piece.sourceEnd - piece.sourceStart;
    if (
      last &&
      last.generatedEnd === mapping.generatedStart &&
      last.sourceEnd === mapping.sourceStart &&
      verbatim(last) &&
      verbatim(mapping)
    ) {
      last.generatedEnd = mapping.generatedEnd;
      last.sourceEnd = mapping.sourceEnd;
    } else {
      out.push({ ...mapping });
    }
  }
  return out;
}

/**
 * Per-atom sub-mappings (decision 156): `code` holds each atom as its string
 * literal (`:a` is `"a"`, one character longer), so one whole-span mapping
 * would drift by one per preceding atom. Each atom maps to its literal and the
 * text between them maps one to one, so a TypeScript error on `type=:emial`
 * lands on the atom. `undefined` (the whole-span mapping) when the text
 * between atoms is not the authored text, as when a binding rewrite
 * (`count` to `count()`) moved it.
 */
function atomMappings(expr: Expr): MappedCode | undefined {
  const span = expr.span;
  if (!span || !expr.atoms?.length) return undefined;
  const mappings: GeneratedMapping[] = [];
  const between = (sourceStart: number, sourceEnd: number, at: number) => {
    if (sourceEnd > sourceStart) {
      mappings.push({
        sourceStart,
        sourceEnd,
        generatedStart: at,
        generatedEnd: at + sourceEnd - sourceStart,
      });
    }
  };
  let source = span.sourceStart;
  let generated = 0;
  for (const atom of expr.atoms) {
    const text = JSON.stringify(atom.name);
    const at = generated + atom.span.sourceStart - source;
    if (expr.code.slice(at, at + text.length) !== text) return undefined;
    between(source, atom.span.sourceStart, generated);
    mappings.push({
      ...atom.span,
      generatedStart: at,
      generatedEnd: at + text.length,
    });
    source = atom.span.sourceEnd;
    generated = at + text.length;
  }
  if (generated + span.sourceEnd - source !== expr.code.length) {
    return undefined;
  }
  between(source, span.sourceEnd, generated);
  return { code: expr.code, mappings };
}

/** Applies one generated-text replacement and keeps non-overlapping mappings aligned. */
export function replaceMapped(
  input: MappedCode,
  search: string,
  replacement: string,
): MappedCode {
  const start = input.code.indexOf(search);
  if (start < 0) return input;
  const end = start + search.length;
  const delta = replacement.length - search.length;
  return {
    code: `${input.code.slice(0, start)}${replacement}${input.code.slice(end)}`,
    mappings: input.mappings.flatMap((mapping) => {
      if (mapping.generatedEnd <= start) return [mapping];
      if (mapping.generatedStart >= end) {
        return [
          {
            ...mapping,
            generatedStart: mapping.generatedStart + delta,
            generatedEnd: mapping.generatedEnd + delta,
          },
        ];
      }
      return [];
    }),
  };
}
