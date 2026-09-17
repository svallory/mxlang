/**
 * The `.map` sidecar (design note A3, "Output mapping").
 *
 * `compile()`'s `RawSourceMap` (`@mxlang/core`) always has an empty
 * `mappings` string — this host emits text directly, with no per-position
 * mappings to derive one from yet (`src/index.ts`'s own doc comment). The
 * sidecar is exactly that v3 envelope: `mx-angular map` reports the source
 * file it names, with no fine-grained line/column resolution until a real
 * map exists.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { RawSourceMap } from "@mxlang/core";

/** Builds the sidecar for `outputFile` compiled from `sourceFile`. */
export function buildMap(
  sourceFile: string,
  outputFile: string,
  compileMap: RawSourceMap,
): RawSourceMap {
  return {
    version: 3,
    file: outputFile,
    sources: [sourceFile],
    sourcesContent: [null],
    names: [],
    mappings: compileMap.mappings,
  };
}

export function writeMap(mapPath: string, map: RawSourceMap): void {
  writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

export function readMap(mapPath: string): RawSourceMap {
  return JSON.parse(readFileSync(mapPath, "utf8"));
}

/**
 * Resolves an emitted `line:col` back to a source position, per
 * `mx-angular map`. With `mappings` empty (the only case today — see the
 * module doc), there is nothing fine-grained to resolve: this reports the
 * source file the sidecar names and says so, rather than fabricating a
 * line/column.
 */
export function resolvePosition(map: RawSourceMap): {
  file: string;
  hasFineGrainedMapping: boolean;
} {
  return {
    file: map.sources[0] ?? "<unknown>",
    hasFineGrainedMapping: map.mappings.length > 0,
  };
}
