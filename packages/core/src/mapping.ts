import type { Expr } from "./ir.ts";

/** A byte range in an MX source file. */
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
  return mapped(expr.code, expr.span ?? null);
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
