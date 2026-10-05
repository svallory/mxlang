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
  return atomMappings(expr) ?? mapped(expr.code, expr.span ?? null);
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
