/**
 * The `.map` sidecar (design note A3, "Output mapping").
 *
 * Two cases, and the sidecar is the same v3 envelope for both:
 *
 * - A **page**'s `compile()` map has an empty `mappings` string — this host
 *   emits text directly, with no per-position mappings to derive one from
 *   yet (`src/index.ts`'s own doc comment). `mx-angular map` reports the
 *   source file the sidecar names and says there is nothing finer.
 * - A **`.ng.mx`**'s map is real: `compileNgMx` rewrites the module with
 *   `MagicString`, which emits a hires mapping for the whole file. That one
 *   is decoded and resolved to a genuine line and column.
 *
 * Task 2.2b makes the page case real too, at which point the first branch
 * stops being reachable — nothing here needs to change when it does.
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

/** One decoded mapping segment, in source-map v3 order. */
interface Segment {
  generatedColumn: number;
  sourceLine: number;
  sourceColumn: number;
}

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decodes a whole VLQ-encoded `mappings` string, one entry per generated
 * line.
 *
 * Hand-rolled rather than pulled from a dependency: this reads four-field
 * segments of an envelope this package itself wrote, and the alternative is
 * a runtime dependency on a source-map library for one consumer of one CLI
 * subcommand.
 */
function decodeAll(mappings: string): Segment[][] {
  const out: Segment[][] = [];
  let sourceLine = 0;
  let sourceColumn = 0;

  for (const line of mappings.split(";")) {
    // Reset per line; the two source fields deliberately do not.
    let generatedColumn = 0;
    const segments: Segment[] = [];
    for (const raw of line.split(",")) {
      if (raw === "") continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const char of raw) {
        const digit = BASE64.indexOf(char);
        if (digit === -1) return out; // not something we wrote; give up
        const hasContinuation = (digit & 32) !== 0;
        value += (digit & 31) << shift;
        if (hasContinuation) {
          shift += 5;
          continue;
        }
        const negative = (value & 1) === 1;
        const magnitude = value >> 1;
        fields.push(negative ? -magnitude : magnitude);
        value = 0;
        shift = 0;
      }
      // A 1-field segment marks generated code with no source; only a 4- or
      // 5-field one carries a source position.
      if (fields.length < 4) continue;
      generatedColumn += fields[0] as number;
      sourceLine += fields[2] as number;
      sourceColumn += fields[3] as number;
      segments.push({ generatedColumn, sourceLine, sourceColumn });
    }
    out.push(segments);
  }
  return out;
}

export interface ResolvedPosition {
  file: string;
  hasFineGrainedMapping: boolean;
  /** 1-based, present only when the map carried a real mapping. */
  line?: number;
  /** 0-based, present only when the map carried a real mapping. */
  column?: number;
}

/**
 * Resolves an emitted `line:col` back to a source position, per
 * `mx-angular map`.
 *
 * With `mappings` empty (a page today) there is nothing fine-grained to
 * resolve, and this reports the source file alone rather than fabricating a
 * position. With a real map (a `.ng.mx`) the nearest segment at or before
 * the requested column wins — the standard source-map lookup, since a
 * segment covers from its own column up to the next one.
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

  // Decoded from the first line, not just the requested one: `sourceLine`
  // and `sourceColumn` are deltas that accumulate across the **whole** map,
  // while `generatedColumn` resets per line. Decoding one line in isolation
  // starts both source fields at zero and yields a position that is wrong by
  // every delta before it — measured as a *negative* column, which is how
  // this was caught.
  const decoded = decodeAll(map.mappings);
  const segments = decoded[generatedLine - 1] ?? [];
  if (segments.length === 0) return { file, hasFineGrainedMapping };

  // The nearest segment at or before the requested column. Seeded with
  // `undefined` rather than `segments[0]`: when even the first segment
  // starts after the column asked for, nothing on this line covers it, and
  // reporting that first segment anyway yields a position the column
  // arithmetic never visited.
  let best: Segment | undefined;
  for (const segment of segments) {
    if (segment.generatedColumn > generatedColumn) break;
    best = segment;
  }
  if (!best) return { file, hasFineGrainedMapping };
  return {
    file,
    hasFineGrainedMapping,
    line: best.sourceLine + 1,
    column: best.sourceColumn,
  };
}
