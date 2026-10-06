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
  const newTokens = tokenize(expr.code);
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
  // Longest common subsequence of tokens.
  const rows = oldTokens.length + 1;
  const cols = newTokens.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = oldTokens.length - 1; i >= 0; i--) {
    for (let j = newTokens.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        oldTokens[i]?.text === newTokens[j]?.text
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * cols + j] ?? 0,
              table[i * cols + j + 1] ?? 0,
            );
    }
  }
  let i = 0;
  let j = 0;
  let gapOld = -1;
  let gapNew = -1;
  const flushGap = (oldIndex: number, newIndex: number) => {
    if (gapOld < 0) return;
    const oldFirst = oldTokens[gapOld];
    const oldLast = oldTokens[oldIndex - 1];
    const newFirst = newTokens[gapNew];
    const newLast = newTokens[newIndex - 1];
    gapOld = -1;
    if (!oldFirst || !oldLast || !newFirst || !newLast) return;
    // A replaced run keeps its authored name as one span.
    emit(oldFirst.start, oldLast.end, newFirst.start, newLast.end, false);
  };
  while (i < oldTokens.length && j < newTokens.length) {
    const a = oldTokens[i];
    const b = newTokens[j];
    if (a && b && a.text === b.text) {
      flushGap(i, j);
      emit(a.start, a.end, b.start, b.end, true);
      i++;
      j++;
    } else {
      if (gapOld < 0) {
        gapOld = i;
        gapNew = j;
      }
      if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0))
        i++;
      else j++;
    }
  }
  if (i < oldTokens.length || j < newTokens.length) {
    if (gapOld < 0) {
      gapOld = i;
      gapNew = j;
    }
    flushGap(oldTokens.length, newTokens.length);
  }
  return { code: expr.code, mappings: mergeAdjacent(mappings) };
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
