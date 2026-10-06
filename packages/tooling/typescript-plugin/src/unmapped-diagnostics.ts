import {
  type CodeMapping,
  type Language,
  shouldReportDiagnostics,
  type VirtualCode,
} from "@volar/language-core";
import type * as ts from "typescript";

/**
 * A diagnostic whose generated position has no source mapping is never
 * dropped (decision 161).
 *
 * Volar maps every TypeScript diagnostic from the generated module back to
 * the `.mx` source and *discards* the ones it cannot map
 * (`transformDiagnostic` returns `undefined`). A page whose errors all sit in
 * generated text no mapping covers therefore type-checked clean: `mx-tsc` exit
 * 0, an editor with no squiggle. This module runs *beneath* Volar — on the
 * raw TypeScript diagnostics — and gives each unmappable one a position Volar
 * can map: the nearest enclosing authored span (attribute, then tag, then the
 * file start), with the message suffixed by {@link approximateSuffix}. A diagnostic Volar can map is returned as the
 * very same object, so exact positions and messages never change.
 *
 * Both tools run the same function: `mx-tsc` through the program Volar
 * decorates, the tsserver plugin through the language service Volar proxies.
 */

/** The text appended to the message of a diagnostic reported approximately. */
export function approximateSuffix(line: number, column: number): string {
  return ` (position approximate: generated ${line}:${column})`;
}

/**
 * The text appended when the diagnostic's generated line holds no authored
 * code at all: the error is in code MX wrote, not in anything the author did.
 */
export function mxBugSuffix(line: number, column: number): string {
  return ` (in MX-generated code, not yours: an MX bug; generated ${line}:${column})`;
}

type Diagnostic = ts.Diagnostic;

/** A source span of authored syntax: a tag or an attribute, file-absolute. */
export interface AuthoredSpan {
  start: number;
  end: number;
}

/**
 * A virtual code that can say which authored constructs (tags and
 * attributes) its source holds. A language plugin sets `authoredSpans`; it is
 * read lazily, only when a diagnostic has no mapping. A code without it falls
 * back to the file start (1:1), never to a neighbouring construct.
 */
export interface SpannedVirtualCode extends VirtualCode {
  authoredSpans?: () => readonly AuthoredSpan[];
}

/** The service script's code, the way Volar's `getServiceScript` finds it. */
function serviceScriptOf(language: Language<string>, fileName: string) {
  const script = language.scripts.get(fileName);
  const generated = script?.generated;
  const serviceScript = generated?.languagePlugin.typescript?.getServiceScript(
    generated.root,
  );
  return script && serviceScript ? { script, serviceScript } : undefined;
}

function lineAndColumn(text: string, offset: number): [number, number] {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return [line, offset - lineStart + 1];
}

/** A mapped range of the generated module and the source it came from. */
interface MappedRange {
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
}

/**
 * The data of every mapping this module adds, so a later diagnostic never
 * counts one of them as authored code or as already mapped.
 */
const overlayData = new WeakSet<object>();

/** The source span each unmapped generated range was given, per virtual code. */
const placed = new WeakMap<
  VirtualCode,
  Map<string, { start: number; length: number }>
>();

/** Every generated range a diagnostic-reporting authored mapping covers. */
function reportedRanges(
  mappings: readonly CodeMapping[],
  source: string,
  code: string,
): MappedRange[] {
  const ranges: MappedRange[] = [];
  for (const mapping of mappings) {
    if (overlayData.has(mapping.data as object)) continue;
    if (!shouldReportDiagnostics(mapping.data, source, code)) continue;
    mapping.generatedOffsets.forEach((start, index) => {
      const length =
        mapping.generatedLengths?.[index] ?? mapping.lengths[index] ?? 0;
      const sourceStart = mapping.sourceOffsets[index] ?? 0;
      ranges.push({
        start,
        end: start + length,
        sourceStart,
        sourceEnd: sourceStart + (mapping.lengths[index] ?? 0),
      });
    });
  }
  return ranges;
}

/** `identifier` as a whole word in `text[lo, hi)`: every occurrence. */
function wordOccurrences(
  text: string,
  word: string,
  lo: number,
  hi: number,
): AuthoredSpan[] {
  const found: AuthoredSpan[] = [];
  const isWord = (ch: string | undefined) => !!ch && /[\w$]/.test(ch);
  for (
    let at = text.indexOf(word, lo);
    at >= 0 && at + word.length <= hi;
    at = text.indexOf(word, at + 1)
  ) {
    if (!isWord(text[at - 1]) && !isWord(text[at + word.length])) {
      found.push({ start: at, end: at + word.length });
    }
  }
  return found;
}

/**
 * The source span an unmappable diagnostic is reported on: the smallest
 * authored construct (an attribute before the tag around it) that encloses
 * where the diagnostic came from. Generated code follows source order, so the
 * diagnostic came from the source *between* the nearest mapped range before it
 * and the nearest one after it. When the diagnostic's text is one identifier
 * the author spelled in that gap, that spelling is where it came from;
 * otherwise (scaffolding) the whole gap is. No enclosing construct, or none
 * known: the file start. A sibling's span is never used.
 */
function enclosingSpan(
  authored: readonly AuthoredSpan[],
  ranges: readonly MappedRange[],
  generatedStart: number,
  generatedEnd: number,
  diagnosticText: string,
  sourceText: string,
): { start: number; length: number } {
  let before: MappedRange | undefined;
  let after: MappedRange | undefined;
  for (const range of ranges) {
    if (range.start <= generatedStart) {
      if (!before || range.end > before.end) before = range;
    } else if (range.start >= generatedEnd) {
      if (!after || range.start < after.start) after = range;
    }
  }
  const from = before?.sourceEnd ?? 0;
  const to = after?.sourceStart ?? sourceText.length;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  let regionStart = lo;
  let regionEnd = hi;
  if (/^[A-Za-z_$][\w$]*$/.test(diagnosticText)) {
    const spelled = wordOccurrences(sourceText, diagnosticText, lo, hi);
    if (spelled.length > 0) {
      regionStart = Math.min(...spelled.map((span) => span.start));
      regionEnd = Math.max(...spelled.map((span) => span.end));
    }
  }
  let best: AuthoredSpan | undefined;
  for (const span of authored) {
    if (span.start > regionStart || span.end < regionEnd) continue;
    if (!best || span.end - span.start < best.end - best.start) best = span;
  }
  return best
    ? { start: best.start, length: best.end - best.start }
    : { start: 0, length: 0 };
}

function suffixed(
  messageText: string | ts.DiagnosticMessageChain,
  suffix: string,
): string | ts.DiagnosticMessageChain {
  return typeof messageText === "string"
    ? messageText + suffix
    : { ...messageText, messageText: messageText.messageText + suffix };
}

/**
 * Maps `[generatedStart, +length)` onto `target` in the module's source map,
 * as a mapping that only lets the diagnostic through (`verification`): no
 * hover, completion or navigation. `@volar/source-map` builds its lookup
 * tables on first use and never again, so the two private memo fields are
 * reset after the mapping is added (pinned by the tests; `@volar/source-map`
 * is an exact-pinned dependency of the packages that bundle this).
 */
function overlay(
  map: { mappings: CodeMapping[] },
  generatedStart: number,
  length: number,
  target: { start: number; length: number },
): void {
  const data = { verification: true };
  overlayData.add(data);
  map.mappings.push({
    sourceOffsets: [target.start],
    generatedOffsets: [generatedStart],
    lengths: [target.length],
    generatedLengths: [length],
    data,
  });
  const memos = map as unknown as Record<string, unknown>;
  memos.generatedCodeOffsetsMemo = undefined;
  memos.sourceCodeOffsetsMemo = undefined;
}

interface Located {
  file?: ts.SourceFile;
  start?: number;
  length?: number;
  messageText: string | ts.DiagnosticMessageChain;
}

function approximateLocated<T extends Located>(
  language: Language<string>,
  diagnostic: T,
  source: string,
  code: string,
): T {
  const { file, start, length } = diagnostic;
  if (!file || start === undefined || length === undefined) return diagnostic;
  const found = serviceScriptOf(language, file.fileName);
  if (!found) return diagnostic;
  const { serviceScript } = found;

  const sourceScript = language.scripts.fromVirtualCode(serviceScript.code);
  const leading = serviceScript.preventLeadingOffset
    ? 0
    : sourceScript.snapshot.getLength();
  const generatedStart = start - leading;
  const generatedEnd = generatedStart + length;
  const map = language.maps.get(serviceScript.code, sourceScript);
  const key = `${generatedStart}:${length}`;
  let target = placed.get(serviceScript.code)?.get(key);
  if (!target) {
    // Any authored mapping covering the range settles it, even one whose
    // `verification` rejects this diagnostic: that is a host deliberately
    // hiding a spurious error (the `.astro.mx` fence's TS1108), which Volar
    // keeps dropping. Only a range no mapping covers is unmapped.
    for (const _ of map.toSourceRange(
      generatedStart,
      generatedEnd,
      true,
      (data) => !overlayData.has(data as object),
    )) {
      return diagnostic;
    }
  }

  const snapshot = serviceScript.code.snapshot;
  const generated = snapshot.getText(0, snapshot.getLength());
  const sourceText = sourceScript.snapshot.getText(
    0,
    sourceScript.snapshot.getLength(),
  );
  const ranges = reportedRanges(serviceScript.code.mappings, source, code);
  if (!target) {
    const authored =
      (serviceScript.code as SpannedVirtualCode).authoredSpans?.() ?? [];
    target = enclosingSpan(
      authored,
      ranges,
      generatedStart,
      generatedEnd,
      generated.slice(generatedStart, generatedEnd).trim(),
      sourceText,
    );
    overlay(map as never, generatedStart, length, target);
    const forCode = placed.get(serviceScript.code) ?? new Map();
    forCode.set(key, target);
    placed.set(serviceScript.code, forCode);
  }

  // Per range, not per line: authored code inside or directly next to the
  // diagnostic's generated range, else code MX wrote.
  const touchesAuthored = ranges.some(
    (range) => range.start <= generatedEnd && range.end >= generatedStart,
  );
  const [line, column] = lineAndColumn(generated, generatedStart);
  return {
    ...diagnostic,
    messageText: suffixed(
      diagnostic.messageText,
      touchesAuthored
        ? approximateSuffix(line, column)
        : mxBugSuffix(line, column),
    ),
  };
}

/**
 * `diagnostic`, or — when Volar could not map it back to the source — a copy
 * Volar can: the generated range is mapped onto the nearest enclosing authored
 * span (see {@link enclosingSpan}) and the message suffixed with
 * {@link approximateSuffix} or {@link mxBugSuffix}. The same goes for each of
 * its `relatedInformation` entries, which Volar would otherwise drop one by
 * one. An exactly mapped diagnostic is returned as the same object.
 */
export function approximateUnmapped<T extends Diagnostic>(
  language: Language<string>,
  diagnostic: T,
): T {
  const source = String(diagnostic.source);
  const code = String(diagnostic.code);
  const own = approximateLocated(language, diagnostic, source, code);
  const related = diagnostic.relatedInformation;
  if (!related) return own;
  const mapped = related.map((entry) =>
    approximateLocated(language, entry, source, code),
  );
  return mapped.every((entry, index) => entry === related[index])
    ? own
    : { ...own, relatedInformation: mapped };
}

/**
 * Wraps the named diagnostic-returning methods of `target` (a TypeScript
 * `Program` or `LanguageService`) so each result goes through
 * {@link approximateUnmapped}. `getLanguage` is read per call: a tsserver
 * project only knows its Volar `Language` once Volar has set it up.
 */
export function approximateUnmappedDiagnostics<T extends object>(
  target: T,
  names: readonly string[],
  getLanguage: () => Language<string> | undefined,
): void {
  const record = target as Record<string, unknown>;
  for (const name of names) {
    const original = record[name];
    if (typeof original !== "function") continue;
    record[name] = (...args: unknown[]) => {
      const diagnostics = original.apply(target, args) as readonly Diagnostic[];
      const language = getLanguage();
      return language
        ? diagnostics.map((diagnostic) =>
            approximateUnmapped(language, diagnostic),
          )
        : diagnostics;
    };
  }
}

/**
 * Wraps `program.emit` so the diagnostics of its result (declaration-emit
 * errors, when `mx-tsc` runs without `--noEmit`) go through
 * {@link approximateUnmapped} too: Volar maps `emit().diagnostics` and drops
 * the unmappable ones like any other.
 */
export function approximateUnmappedEmit(
  program: { emit: ts.Program["emit"] },
  getLanguage: () => Language<string> | undefined,
): void {
  const original = program.emit;
  program.emit = (...args) => {
    const result = original.apply(program, args);
    const language = getLanguage();
    return language
      ? {
          ...result,
          diagnostics: result.diagnostics.map((diagnostic) =>
            approximateUnmapped(language, diagnostic),
          ),
        }
      : result;
  };
}

/** The `ts.Program` methods whose diagnostics Volar maps (`decorateProgram`). */
export const PROGRAM_DIAGNOSTIC_METHODS = [
  "getSyntacticDiagnostics",
  "getSemanticDiagnostics",
  "getGlobalDiagnostics",
  "getDeclarationDiagnostics",
  "getBindAndCheckDiagnostics",
] as const;

/** The `ts.LanguageService` methods whose diagnostics Volar maps. */
export const LANGUAGE_SERVICE_DIAGNOSTIC_METHODS = [
  "getSyntacticDiagnostics",
  "getSemanticDiagnostics",
  "getSuggestionDiagnostics",
] as const;
