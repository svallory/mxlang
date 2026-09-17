/**
 * The `.map` sidecar (design note A3, "Output mapping").
 *
 * Two cases, and the sidecar is the same v3 envelope for both — since task
 * 2.2b, both carry a real map:
 *
 * - A **page**'s `compile()` map is built from the spans the emitter records
 *   for every run of source-derived text it writes (`./mapping.ts`).
 * - A **`.ng.mx`**'s map is `compileNgMx`'s `MagicString` rewrite, whose
 *   hires mapping covers the whole file, plus the per-region identifier
 *   mappings the same emitter recorded.
 *
 * Either way `mx-angular map` resolves an emitted `line:col` to the position
 * in the `.mx` it came from. A position in text the emitter *invented* — the
 * `<` of a tag, the `="` around a binding, the punctuation after an
 * expression — resolves to no line/column and is reported as such, never
 * fabricated.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { RawSourceMap } from "@mxlang/core";
import { lookupMapping } from "./mapping.ts";

/**
 * Builds the sidecar for `outputFile` compiled from `sourceFile`.
 *
 * `headerLines` is how many lines the generated header prepends to the
 * emitted output. The sidecar describes the file **on disk**, header
 * included, while `compileMap` is relative to the emitted body alone — so
 * every generated line shifts down by that many. A v3 `mappings` string
 * encodes one `;` per generated line, so the shift is exactly that many
 * leading semicolons, no re-encoding needed.
 *
 * The `.ng.mx` path in `build.ts` applies this same shift to its own map
 * before calling here, and passes no `headerLines`, so the offset is never
 * applied twice.
 */
export function buildMap(
  sourceFile: string,
  outputFile: string,
  compileMap: RawSourceMap,
  headerLines = 0,
): RawSourceMap {
  return {
    version: 3,
    file: outputFile,
    sources: [sourceFile],
    sourcesContent: [null],
    names: [],
    mappings:
      compileMap.mappings.length > 0
        ? ";".repeat(headerLines) + compileMap.mappings
        : compileMap.mappings,
  };
}

export function writeMap(mapPath: string, map: RawSourceMap): void {
  writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

export function readMap(mapPath: string): RawSourceMap {
  return JSON.parse(readFileSync(mapPath, "utf8"));
}

export interface ResolvedPosition {
  file: string;
  hasFineGrainedMapping: boolean;
  /** 1-based, present only when the position resolved to source text. */
  line?: number;
  /** 0-based, present only when the position resolved to source text. */
  column?: number;
}

/**
 * Resolves an emitted `line:col` back to a source position, per
 * `mx-angular map`.
 *
 * With `mappings` empty there is nothing to resolve and the source file is
 * reported alone. Otherwise the lookup runs through `lookupMapping`
 * (`./mapping.ts`), which honours the terminator segments the encoder emits
 * at each mapped run's end — so a position *past* a run resolves to no
 * position rather than inheriting that run's, which a plain
 * nearest-segment-at-or-before search would do.
 */
export function resolvePosition(
  map: RawSourceMap,
  generatedLine?: number,
  generatedColumn?: number,
): ResolvedPosition {
  const file = map.sources[0] ?? "<unknown>";
  const hasFineGrainedMapping = map.mappings.length > 0;
  if (
    !hasFineGrainedMapping ||
    generatedLine === undefined ||
    generatedColumn === undefined
  ) {
    return { file, hasFineGrainedMapping };
  }

  const source = lookupMapping(map.mappings, {
    line: generatedLine,
    column: generatedColumn,
  });
  if (!source) return { file, hasFineGrainedMapping };
  return {
    file,
    hasFineGrainedMapping,
    line: source.line,
    column: source.column,
  };
}
