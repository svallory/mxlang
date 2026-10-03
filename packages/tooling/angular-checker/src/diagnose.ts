/**
 * Angular template diagnostics for a compiled `.ng.mx`, positioned in the
 * `.ng.mx` source.
 *
 * `@mxlang/angular-checker` checks a TypeScript *module* and reports offsets
 * into it. A `.ng.mx` author never sees that module, so every diagnostic is
 * mapped back before it leaves this package.
 */

import {
  anchorFor,
  type CompileNgMxResult,
  lineColumnAt,
  lookupMapping,
  offsetAt,
  sourceOffsetFor,
} from "@mxlang/angular";
import type {
  AngularChecker,
  Diagnostic,
  DiagnosticCategory,
} from "./types.ts";

/** One Angular template diagnostic, positioned in the `.ng.mx` source. */
export interface NgMxDiagnostic {
  /** Offset into the `.ng.mx` source, in UTF-16 code units. */
  start: number;
  /**
   * Length of the flagged source span. For a diagnostic inside a mapped
   * expression this is the whole expression (whole-to-whole: escaping means
   * sub-expression offsets do not advance in step), otherwise `0`.
   */
  length: number;
  /** Angular's diagnostic code; negative for template parse errors. */
  code: number;
  /** Angular's message, with compact MX-specific fix advice when known. */
  message: string;
  category: DiagnosticCategory;
  source: "angular";
  /**
   * How exactly `start` locates the problem. `"exact"`: inside a mapped
   * expression (the whole expression's start). `"node"`: on the start tag or
   * attribute the author wrote (`length` covers its name, or the attribute
   * name through value) — what NG8001/NG8002 report against. Degraded, so
   * tooling can say the location is approximate: `"region"` the start of the enclosing
   * `template:` region; `"sourcemap"` the module source map's nearest
   * position; `"none"` nothing located it and `start` is 0.
   */
  mapped: NgMxMapped;
}

export type NgMxMapped = "exact" | "node" | "region" | "sourcemap" | "none";

/**
 * Resolve an offset in the emitted module to a `.ng.mx` position, never
 * failing: a mapped expression, else the start tag or attribute it falls in,
 * else the enclosing region's start, else the
 * module source map, else the top of the file. A diagnostic must not vanish
 * because its position is awkward, or a broken file would read as clean.
 */
function locate(
  compiled: CompileNgMxResult,
  generatedOffset: number,
): { start: number; length: number; mapped: NgMxMapped } {
  const start = sourceOffsetFor(compiled.mappings, generatedOffset);
  if (start !== null) {
    let length = 0;
    let best = Number.POSITIVE_INFINITY;
    for (const m of compiled.mappings) {
      const generatedSpan = m.generatedEnd - m.generatedStart;
      if (
        m.sourceStart === start &&
        generatedOffset >= m.generatedStart &&
        generatedOffset < m.generatedEnd &&
        generatedSpan < best
      ) {
        best = generatedSpan;
        length = m.sourceEnd - m.sourceStart;
      }
    }
    return { start, length, mapped: "exact" };
  }

  const anchor = anchorFor(compiled.anchors, generatedOffset);
  if (anchor) {
    return {
      start: anchor.sourceStart,
      length: anchor.sourceEnd - anchor.sourceStart,
      mapped: "node",
    };
  }

  const region = compiled.regions.find(
    (r) =>
      generatedOffset >= r.generatedStart && generatedOffset < r.generatedEnd,
  );
  if (region) return { start: region.start, length: 0, mapped: "region" };

  const source = compiled.map.sourcesContent?.[0];
  if (typeof source === "string") {
    const original = lookupMapping(
      compiled.map.mappings,
      lineColumnAt(compiled.code, generatedOffset),
    );
    if (original) {
      return {
        start: offsetAt(source, original),
        length: 0,
        mapped: "sourcemap",
      };
    }
  }
  return { start: 0, length: 0, mapped: "none" };
}

/**
 * A concrete numeric-argument example is safe only for a reference whose
 * rejected signature actually takes two numbers. Keep other event type
 * errors verbatim rather than inventing arguments that would not compile.
 */
function eventHandlerHint(
  compiled: CompileNgMxResult,
  diagnostic: Diagnostic,
): string {
  if (
    diagnostic.code !== 2345 ||
    compiled.code.slice(diagnostic.start - 7, diagnostic.start) !== "__mxOn(" ||
    !/^Argument of type '\([^:]+: number, [^:]+: number\) =>/.test(
      diagnostic.message,
    ) ||
    !diagnostic.message.includes("element: EventTarget | null")
  )
    return diagnostic.message;
  const source = compiled.map.sourcesContent?.[0];
  const anchor = anchorFor(compiled.anchors, diagnostic.start);
  if (typeof source !== "string" || !anchor) return diagnostic.message;
  const attribute = source.slice(anchor.sourceStart, anchor.sourceEnd);
  const match =
    /^(on(?:-[\w-]+|[A-Z]\w*|click))\s*=\s*([A-Za-z_$][\w$]*)$/.exec(attribute);
  if (!match) return diagnostic.message;
  const [, name, handler] = match;
  return `Handler \`${handler}\` expects \`(number, number)\`; MX passes \`(event, element)\`. Use \`${name}=(() => ${handler}(1, 2))\`.`;
}

/**
 * Map checker records for a compiled `.ng.mx` to positions in the `.ng.mx`.
 *
 * Only `source: "ngtsc"` records are kept. The `"ts"` records (errors in the
 * module's own TypeScript) are dropped: Volar and `tsc` already report those,
 * and repeating them would print each twice.
 *
 * Split out of {@link diagnoseNgMx} for hosts that get their records from a
 * checker worker process instead of calling `check` themselves.
 */
export function mapNgMxDiagnostics(
  compiled: CompileNgMxResult,
  records: readonly Diagnostic[],
): NgMxDiagnostic[] {
  return records
    .filter((d) => d.source === "ngtsc")
    .map((d) => ({
      ...locate(compiled, d.start),
      code: d.code,
      message: eventHandlerHint(compiled, d),
      category: d.category,
      source: "angular" as const,
    }));
}

/**
 * Check a compiled `.ng.mx` and return its Angular template diagnostics,
 * positioned in the `.ng.mx` (see {@link mapNgMxDiagnostics} for what is kept).
 *
 * `virtualPath` is where the module is presented to the checker; it must sit
 * in the project so `@angular/core` resolves (see the README).
 */
export function diagnoseNgMx(
  compiled: CompileNgMxResult,
  checker: AngularChecker,
  virtualPath: string,
): NgMxDiagnostic[] {
  return mapNgMxDiagnostics(
    compiled,
    checker.check(virtualPath, compiled.code),
  );
}
