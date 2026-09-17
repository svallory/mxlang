/**
 * Position mapping for `@mxlang/angular` (design note A5, task 2.2b).
 *
 * The emitter builds its template by appending text, so mappings are recorded
 * as it goes rather than derived afterwards from node positions: a
 * {@link TemplateWriter} owns the output string and, for every run of text
 * that came from source, records the generated span it just wrote against the
 * source span it came from.
 *
 * ## The escaping rule
 *
 * A mapped run is recorded **whole-to-whole**: the entire generated span maps
 * to the entire source span, with no attempt to map sub-expressions. This is
 * what makes escaping safe. `esc()` turns `a & b` into `a &amp; b` and the
 * brace escaping turns `{` into `{{ '{' }}`, so generated and source lengths
 * routinely differ; a character-by-character correspondence would be wrong at
 * every character after the first escape. Whole-to-whole stays correct
 * regardless, because it claims only that this emitted run came from that
 * source text — which is exactly what the `.ng.mx` diagnostics path (2.3)
 * needs to turn an Angular offset back into an MX position.
 *
 * The consequence to know: a diagnostic pointing *inside* an emitted
 * expression resolves to the start of the whole source expression, not to the
 * character within it. Angular reports most template diagnostics against the
 * expression as a unit, so this is rarely visible, and the alternative
 * (claiming a precision the escaping does not support) would point at the
 * wrong character rather than a coarser-but-correct one.
 */

import {
  decode,
  encode,
  type SourceMapSegment,
} from "@jridgewell/sourcemap-codec";
import type { GeneratedMapping, SourceSpan } from "@mxlang/core";

/**
 * Accumulates emitted template text and the mappings into it.
 *
 * Text is appended either unmapped (`write`) or mapped to a source span
 * (`writeMapped`). Only source-derived names and expressions are mapped; the
 * punctuation the emitter invents around them (`<`, `="`, `@if (`) is not,
 * because it exists in no source file and has no position to report.
 */
export class TemplateWriter {
  #out = "";
  readonly #mappings: GeneratedMapping[] = [];

  /** The text written so far. */
  get code(): string {
    return this.#out;
  }

  /** How many bytes have been written; the next write's generated start. */
  get length(): number {
    return this.#out.length;
  }

  /** Appends generated punctuation or structure, which maps to nothing. */
  write(text: string): void {
    this.#out += text;
  }

  /**
   * Appends `text` and maps the whole of it to the whole of `span`.
   *
   * A null span means the text has no authored source — a synthesized
   * expression, a gensym'd loop variable, a fabricated default — and is
   * written unmapped rather than mapped to a position the author never wrote.
   */
  writeMapped(text: string, span: SourceSpan | null | undefined): void {
    const start = this.#out.length;
    this.#out += text;
    // A zero-length run would map an empty generated span, which no lookup
    // can ever land inside; skip it rather than record an unreachable entry.
    if (span && text.length > 0) {
      this.#mappings.push({
        sourceStart: span.sourceStart,
        sourceEnd: span.sourceEnd,
        generatedStart: start,
        generatedEnd: start + text.length,
      });
    }
  }

  /**
   * Adopts a nested writer's output, rebasing its mappings onto this one.
   *
   * A child emitter builds `<if>`/`<for>` bodies and attribute-tag content
   * against its own zero offset, so its mappings are relative to its own text
   * and have to be shifted by wherever that text lands here.
   */
  writeNested(nested: { code: string; mappings: GeneratedMapping[] }): void {
    const offset = this.#out.length;
    this.#out += nested.code;
    for (const mapping of nested.mappings) {
      this.#mappings.push({
        ...mapping,
        generatedStart: mapping.generatedStart + offset,
        generatedEnd: mapping.generatedEnd + offset,
      });
    }
  }

  /** The mappings recorded so far, in the order they were written. */
  get mappings(): readonly GeneratedMapping[] {
    return this.#mappings;
  }

  /** The finished text and its mappings. */
  result(): { code: string; mappings: GeneratedMapping[] } {
    return { code: this.#out, mappings: [...this.#mappings] };
  }
}

/**
 * Rebases `mappings` by `offset`, for a template embedded in a larger file.
 *
 * `compileTagModule` emits the template inside a module's backtick template
 * literal, so every generated offset the emitter recorded is relative to the
 * template, not to the module text the caller will actually index into.
 */
export function offsetMappings(
  mappings: readonly GeneratedMapping[],
  offset: number,
): GeneratedMapping[] {
  return mappings.map((mapping) => ({
    ...mapping,
    generatedStart: mapping.generatedStart + offset,
    generatedEnd: mapping.generatedEnd + offset,
  }));
}

/**
 * Resolves a generated offset back to its source offset.
 *
 * This is the round-trip the `.ng.mx` diagnostics path (2.3) runs: Angular
 * reports a diagnostic as an offset inside the template string, and this
 * turns it back into an offset in the `.mx` source.
 *
 * Returns the source offset of the **innermost** mapping containing
 * `generatedOffset`, or `null` when the offset falls in generated
 * punctuation that came from no source text. Innermost wins because mappings
 * nest — an attribute's expression lies inside the element that contains it —
 * and the narrowest span is the most specific answer.
 *
 * Per the whole-to-whole rule, the result is the mapping's source *start*:
 * the offset within the generated run is deliberately not added, because
 * escaping means generated and source offsets do not advance in step.
 */
export function sourceOffsetFor(
  mappings: readonly GeneratedMapping[],
  generatedOffset: number,
): number | null {
  let best: GeneratedMapping | undefined;
  for (const mapping of mappings) {
    if (
      generatedOffset < mapping.generatedStart ||
      generatedOffset >= mapping.generatedEnd
    ) {
      continue;
    }
    if (
      !best ||
      mapping.generatedEnd - mapping.generatedStart <
        best.generatedEnd - best.generatedStart
    ) {
      best = mapping;
    }
  }
  return best ? best.sourceStart : null;
}

/** A line/column position, 1-based line and 0-based column. */
export interface LineColumn {
  line: number;
  column: number;
}

/** Converts a byte offset in `text` to its line/column. */
export function lineColumnAt(text: string, offset: number): LineColumn {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart };
}

/** Converts a 1-based line and 0-based column in `text` to a byte offset. */
export function offsetAt(text: string, position: LineColumn): number {
  let offset = 0;
  for (let line = 1; line < position.line; line += 1) {
    const next = text.indexOf("\n", offset);
    // Past the end of the text: clamp rather than return a negative offset.
    if (next < 0) return text.length;
    offset = next + 1;
  }
  const lineEnd = text.indexOf("\n", offset);
  const end = lineEnd < 0 ? text.length : lineEnd;
  return Math.min(offset + position.column, end);
}

/**
 * Resolves a generated `line:col` in the emitted template to a source
 * `line:col` in the `.mx` file — what `mx-angular map` reports.
 */
export function resolveLineColumn(
  generated: string,
  source: string,
  mappings: readonly GeneratedMapping[],
  position: LineColumn,
): LineColumn | null {
  const sourceOffset = sourceOffsetFor(mappings, offsetAt(generated, position));
  return sourceOffset === null ? null : lineColumnAt(source, sourceOffset);
}

/**
 * Builds the `mappings` string of a source map v3 from our own mappings.
 *
 * Each mapping contributes **two** segments: one at its generated start
 * pointing at its source start, and a **terminator** at its generated end
 * with no source fields. The terminator is what bounds the run — a v3
 * segment marks where a run begins and the run extends to the next segment,
 * so without it a decoder would attribute every byte after the run, to the
 * end of the line, to the same source position. That is the over-claim
 * `lookupMapping` used to inherit.
 *
 * A terminator is omitted where the next mapping starts exactly at this
 * one's end, since that mapping's own segment already bounds it.
 */
export function encodeMappings(
  generated: string,
  source: string,
  mappings: readonly GeneratedMapping[],
): string {
  const starts = new Set(mappings.map((mapping) => mapping.generatedStart));
  type Point = { gen: LineColumn; src: LineColumn | null };
  const points: Point[] = [];
  for (const mapping of mappings) {
    points.push({
      gen: lineColumnAt(generated, mapping.generatedStart),
      src: lineColumnAt(source, mapping.sourceStart),
    });
    if (!starts.has(mapping.generatedEnd)) {
      points.push({
        gen: lineColumnAt(generated, mapping.generatedEnd),
        src: null,
      });
    }
  }
  // v3 requires segments in generated order; the emitter writes in that
  // order already, but terminators interleave and a caller may have
  // concatenated several runs.
  points.sort((a, b) =>
    a.gen.line === b.gen.line
      ? a.gen.column - b.gen.column
      : a.gen.line - b.gen.line,
  );

  // One entry per generated line, as `encode` expects; `lines[i]` is line
  // `i + 1`. Lines past the last mapped one are omitted, which is legal —
  // a decoder treats a missing trailing line as having no segments.
  const lines: SourceMapSegment[][] = [];
  for (const point of points) {
    while (lines.length < point.gen.line) lines.push([]);
    const line = lines[point.gen.line - 1];
    if (!line) continue;
    line.push(
      point.src
        ? // Field 2 is the index into `sources`, always 0: one source file.
          [point.gen.column, 0, point.src.line - 1, point.src.column]
        : [point.gen.column],
    );
  }
  return encode(lines);
}

/**
 * Rebases template-relative mappings onto a module that embeds the template
 * as a `JSON.stringify`'d string starting at `quotedStart`.
 *
 * `JSON.stringify` escapes per character, so a run containing a quote, a
 * backslash or a control character occupies more bytes quoted than raw and
 * every offset after it shifts. Rather than guess, each run's own quoted
 * form is computed: when it is byte-identical to the raw form the mapping is
 * rebased past the quoted prefix, and when it is not, the mapping is
 * **dropped** — a span that would slice the wrong bytes out of the module is
 * worse than no span at all.
 *
 * The quoted length of every prefix is accumulated in one pass rather than
 * re-stringifying the prefix per mapping, which was quadratic in the
 * template's length.
 */
export function templateMappingsToModule(
  template: string,
  mappings: readonly GeneratedMapping[],
  quotedStart: number,
): GeneratedMapping[] {
  // Quoted length per character, prefix-summed: `quotedUpTo[i]` is how many
  // bytes `template.slice(0, i)` occupies inside the quoted string.
  const quotedUpTo = new Int32Array(template.length + 1);
  for (let i = 0; i < template.length; i += 1) {
    const char = template[i] as string;
    quotedUpTo[i + 1] =
      (quotedUpTo[i] as number) + JSON.stringify(char).length - 2;
  }

  const out: GeneratedMapping[] = [];
  for (const mapping of mappings) {
    const run = template.slice(mapping.generatedStart, mapping.generatedEnd);
    const quotedRunLength =
      (quotedUpTo[mapping.generatedEnd] as number) -
      (quotedUpTo[mapping.generatedStart] as number);
    // An escaped character inside the run would make the module's bytes
    // differ from the source text this mapping claims.
    if (quotedRunLength !== run.length) continue;
    // +1 for the opening quote of the embedded string.
    const start =
      quotedStart + 1 + (quotedUpTo[mapping.generatedStart] as number);
    out.push({
      sourceStart: mapping.sourceStart,
      sourceEnd: mapping.sourceEnd,
      generatedStart: start,
      generatedEnd: start + run.length,
    });
  }
  return out;
}

/**
 * Resolves a position in the generated file to its source position, reading
 * a source map v3 `mappings` string directly.
 *
 * This is what `mx-angular map` runs: it holds the `.map` sidecar, not the
 * in-memory `GeneratedMapping[]`, so it decodes rather than searching spans.
 *
 * On the requested line it takes the last segment at or before the column.
 * A run is bounded by the next segment, so landing on a **terminator** (a
 * one-field segment, carrying a generated column but no source) means the
 * position is past the end of the preceding run and resolves to null rather
 * than inheriting that run's source position. This is what keeps `map` from
 * fabricating a position for trailing punctuation.
 */
export function lookupMapping(
  mappings: string,
  position: LineColumn,
): LineColumn | null {
  const lines = decode(mappings);
  const line = lines[position.line - 1];
  if (!line) return null;
  let best: LineColumn | null = null;
  for (const segment of line) {
    const [generatedColumn] = segment;
    if (generatedColumn > position.column) break;
    // `decode` returns absolute values, not deltas, so a segment is read
    // directly. A 1-field segment is a terminator: it bounds the preceding
    // run and maps to nothing itself.
    best =
      segment.length >= 4
        ? { line: (segment[2] as number) + 1, column: segment[3] as number }
        : null;
  }
  return best;
}
