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
 * file start), with the message suffixed by {@link approximateSuffix},
 * {@link unknownPositionSuffix} or {@link mxBugSuffix}. A diagnostic Volar can
 * map is returned as the very same object, so exact positions and messages
 * never change.
 *
 * Both tools run the same function: `mx-tsc` through the program Volar
 * decorates, the tsserver plugin through the language service Volar proxies.
 */

/** The text appended to the message of a diagnostic reported approximately. */
export function approximateSuffix(line: number, column: number): string {
  return ` (position approximate: generated ${line}:${column})`;
}

/**
 * The text appended when the diagnostic is about nothing the author wrote:
 * its text is spelled nowhere in the source it came from, and its generated
 * range touches no mapped authored code. The error is in code MX wrote.
 */
export function mxBugSuffix(line: number, column: number): string {
  return ` (in MX-generated code, not yours: an MX bug; generated ${line}:${column})`;
}

/**
 * The text appended to an author's diagnostic in a virtual code that exposes no
 * authored spans (a failed module's stand-in, a third-party file kind whose
 * language plugin sets no `authoredSpans`): it is reported at the file start
 * (1:1) because nothing closer is known, which is not a position near the
 * error at all.
 */
export function unknownPositionSuffix(line: number, column: number): string {
  return ` (position unknown in this file kind: generated ${line}:${column})`;
}

type Diagnostic = ts.Diagnostic;

/**
 * A source span of authored syntax, file-absolute. A `tag` or an `attribute`
 * is a construct a diagnostic can be reported on; `code` (an expression, an
 * attribute value, a statement) is never a landing place, only where an
 * author's identifier or literal counts as spelled — static text and quoted
 * attribute strings are not code.
 */
export interface AuthoredSpan {
  kind: "tag" | "attribute" | "code";
  start: number;
  end: number;
}

/**
 * A virtual code that can say which authored constructs (tags and
 * attributes) and code its source holds. A language plugin sets
 * `authoredSpans`; it is read lazily, only when a diagnostic has no mapping.
 * A code without it falls back to the file start (1:1), never to a
 * neighbouring construct, and says the position is unknown.
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

/** The offset each line of `text` starts at. */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1))
    starts.push(at + 1);
  return starts;
}

/** 1-based line and column of `offset`, by binary search in `starts`. */
function lineAndColumn(starts: readonly number[], offset: number) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return [lo + 1, offset - (starts[lo] ?? 0) + 1] as const;
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

/**
 * Where an unmapped generated range is reported, and whether the author
 * spelled its text in the source it came from.
 */
interface Placement {
  start: number;
  length: number;
  spelled: boolean;
}

/** The placement each unmapped generated range was given, per virtual code. */
const placed = new WeakMap<VirtualCode, Map<string, Placement>>();

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

/** A token the narrowing can look for: an identifier or a literal. */
const TOKEN = /^(?:[A-Za-z_$][\w$]*|\d[\w.]*|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`)$/;
/**
 * The tag name of a JSX element's opening or closing text: `<p title={x}>`
 * and `</p>` are both `p`.
 */
const ELEMENT = /^<(\/?)([A-Za-z_$][\w$.:-]*)/;
const isWordChar = (ch: string | undefined) => !!ch && /[\w$]/.test(ch);

/**
 * Every occurrence of `token` in `text[lo, hi)`, as a token: a word character
 * at either end of it must not continue into the text around it.
 */
function tokenOccurrences(
  text: string,
  token: string,
  lo: number,
  hi: number,
): AuthoredSpan[] {
  const found: AuthoredSpan[] = [];
  const open = isWordChar(token[0]);
  const close = isWordChar(token[token.length - 1]);
  for (
    let at = text.indexOf(token, lo);
    at >= 0 && at + token.length <= hi;
    at = text.indexOf(token, at + 1)
  ) {
    if (open && isWordChar(text[at - 1])) continue;
    if (close && isWordChar(text[at + token.length])) continue;
    found.push({ kind: "code", start: at, end: at + token.length });
  }
  return found;
}

/** Whether a tag (`<name …`) or an attribute (`name=…`) is named `name`. */
function isNamed(span: AuthoredSpan, name: string, sourceText: string) {
  const at = span.kind === "tag" ? span.start + 1 : span.start;
  return (
    (span.kind === "attribute" || sourceText[span.start] === "<") &&
    sourceText.startsWith(name, at) &&
    !/[\w$.:-]/.test(sourceText[at + name.length] ?? "")
  );
}

/**
 * Where the author spelled what the diagnostic is about, inside the gap
 * `[lo, hi)`: the tag of an element diagnostic (`<p …>`); for an identifier
 * or a literal, the name of a tag or attribute, or a spelling in code — an
 * expression, an attribute value, a statement — never in static text or a
 * quoted attribute string. A virtual code without authored spans cannot tell
 * code from text, so there the whole gap is searched.
 */
function spellings(
  authored: readonly AuthoredSpan[] | undefined,
  lo: number,
  hi: number,
  diagnosticText: string,
  sourceText: string,
): AuthoredSpan[] {
  const [, closing, element] = ELEMENT.exec(diagnosticText) ?? [];
  if (element) {
    if (!authored)
      return tokenOccurrences(sourceText, `<${closing}${element}`, lo, hi);
    // An opening tag starts in the gap, or one character before it: a printer
    // that maps `return <` for the `<` of a fragment it wrapped around the
    // root element ends the mapped range inside the tag's own first
    // character. A closing tag ends its tag's span.
    return authored.filter(
      (span) =>
        span.kind === "tag" &&
        (closing
          ? span.end > lo && span.end <= hi
          : span.start >= lo - 1 && span.start < hi) &&
        isNamed(span, element, sourceText),
    );
  }
  if (!TOKEN.test(diagnosticText)) return [];
  if (!authored) return tokenOccurrences(sourceText, diagnosticText, lo, hi);
  // Only the name has to lie in the gap: an attribute whose value is mapped
  // (`class=1`) ends the gap at that value, inside the attribute's span.
  const named = authored
    .filter((span) => span.kind !== "code")
    .map((span) => {
      const start = span.kind === "tag" ? span.start + 1 : span.start;
      return { span, start, end: start + diagnosticText.length };
    })
    .filter(
      ({ span, start, end }) =>
        start >= lo && end <= hi && isNamed(span, diagnosticText, sourceText),
    )
    .map(({ span, start, end }) => ({ ...span, start, end }));
  const inCode = authored
    .filter((span) => span.kind === "code" && span.end > lo && span.start < hi)
    .flatMap((span) =>
      tokenOccurrences(
        sourceText,
        diagnosticText,
        Math.max(lo, span.start),
        Math.min(hi, span.end),
      ),
    );
  return [...named, ...inCode];
}

/**
 * Where an unmappable diagnostic is reported: the smallest authored construct
 * (an attribute before the tag around it) that encloses where the diagnostic
 * came from. Generated code follows source order, so the diagnostic came from
 * the source *between* the nearest mapped range before it and the nearest one
 * after it. When the author spelled the diagnostic's text there (see
 * {@link spellings}), those spellings are where it came from, and it is the
 * author's; otherwise (scaffolding) the whole gap is. No enclosing construct,
 * or none known: the file start. A sibling's span is never used.
 *
 * Computed from the module's own mappings only, never from the overlays added
 * for other diagnostics, so the answer does not depend on the order
 * diagnostics arrive in.
 */
function enclosingSpan(
  authored: readonly AuthoredSpan[] | undefined,
  ranges: readonly MappedRange[],
  generatedStart: number,
  generatedEnd: number,
  diagnosticText: string,
  sourceText: string,
): Placement {
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
  const spelled = spellings(authored, lo, hi, diagnosticText, sourceText);
  const regionStart =
    spelled.length > 0 ? Math.min(...spelled.map((span) => span.start)) : lo;
  const regionEnd =
    spelled.length > 0 ? Math.max(...spelled.map((span) => span.end)) : hi;
  let best: AuthoredSpan | undefined;
  for (const span of authored ?? []) {
    if (span.kind === "code") continue;
    if (span.start > regionStart || span.end < regionEnd) continue;
    if (!best || span.end - span.start < best.end - best.start) best = span;
  }
  return {
    start: best?.start ?? 0,
    length: best ? best.end - best.start : 0,
    spelled: spelled.length > 0,
  };
}

function suffixed(
  messageText: string | ts.DiagnosticMessageChain,
  suffix: string,
): string | ts.DiagnosticMessageChain {
  return typeof messageText === "string"
    ? messageText + suffix
    : { ...messageText, messageText: messageText.messageText + suffix };
}

/** A source map's mappings, plus the two private lookup memos it keeps. */
type MutableMap = { mappings: CodeMapping[] } & Record<string, unknown>;

/** What one virtual code's diagnostics share within one wrapper call. */
interface CodeState {
  map: MutableMap;
  generated: string;
  sourceText: string;
  lineStarts: number[];
  /** Per `source:code` of the diagnostic: which mappings report it. */
  ranges: Map<string, MappedRange[]>;
  spans?: readonly AuthoredSpan[];
  /** Overlays placed in this call, added to `map` when the call ends. */
  pending: CodeMapping[];
}

/**
 * The work of one wrapper call: everything read from a virtual code is read
 * once, and the overlays for all of its diagnostics are added in one go, so
 * Volar rebuilds its lookup tables once per call instead of once per
 * diagnostic (602 unmapped TS7026 took 26 s that way).
 */
type Batch = Map<VirtualCode, CodeState>;

/** `authoredSpans()` per virtual code: a code is replaced on every compile. */
const authoredMemo = new WeakMap<VirtualCode, readonly AuthoredSpan[]>();

function authoredSpansOf(code: SpannedVirtualCode) {
  if (!code.authoredSpans) return undefined;
  let spans = authoredMemo.get(code);
  if (!spans) {
    spans = code.authoredSpans();
    authoredMemo.set(code, spans);
  }
  return spans;
}

/**
 * Adds the overlays placed during a call to their source maps: each maps a
 * diagnostic's generated range onto its placement, as a mapping that only lets
 * the diagnostic through (`verification`): no hover, completion or
 * navigation. `@volar/source-map` builds its lookup tables on first use and
 * never again, so the two private memo fields are reset after the mappings
 * change (pinned by the tests; `@volar/source-map` is an exact-pinned
 * dependency of the packages that bundle this).
 *
 * Volar takes the first mapping, in array order, that holds both ends of a
 * diagnostic's range. Overlays therefore stay after the module's own mappings
 * and are kept shortest first: a diagnostic nested inside another one's range
 * finds its own overlay before the enclosing one, whichever was placed first.
 */
function flush(batch: Batch): void {
  for (const state of batch.values()) {
    if (state.pending.length === 0) continue;
    const { map } = state;
    const own: CodeMapping[] = [];
    const overlays: CodeMapping[] = [...state.pending];
    for (const mapping of map.mappings) {
      (overlayData.has(mapping.data as object) ? overlays : own).push(mapping);
    }
    const length = (mapping: CodeMapping) => mapping.generatedLengths?.[0] ?? 0;
    overlays.sort((a, b) => length(a) - length(b));
    map.mappings.splice(0, map.mappings.length, ...own, ...overlays);
    map.generatedCodeOffsetsMemo = undefined;
    map.sourceCodeOffsetsMemo = undefined;
    state.pending = [];
  }
}

interface Located {
  file?: ts.SourceFile;
  start?: number;
  length?: number;
  messageText: string | ts.DiagnosticMessageChain;
}

/**
 * Whether a file is compiled from MX: every MX file kind ends in `.mx`
 * (`.mx`, `.solid.mx`, `.astro.mx`, `.ng.mx`, a third-party `.<kind>.mx`).
 * Another language's virtual code (a plain `.astro` file under `--astro`) is
 * left to Volar: MX did not write it and says nothing about it.
 */
const isMxFile = (fileName: string) => /\.mx$/i.test(fileName);

function approximateLocated<T extends Located>(
  language: Language<string>,
  diagnostic: T,
  source: string,
  code: string,
  batch: Batch,
): T {
  const { file, start, length } = diagnostic;
  if (!file || start === undefined || length === undefined) return diagnostic;
  if (!isMxFile(file.fileName)) return diagnostic;
  const found = serviceScriptOf(language, file.fileName);
  if (!found) return diagnostic;
  const { serviceScript } = found;
  const virtual = serviceScript.code;

  const sourceScript = language.scripts.fromVirtualCode(virtual);
  const leading = serviceScript.preventLeadingOffset
    ? 0
    : sourceScript.snapshot.getLength();
  const generatedStart = start - leading;
  const generatedEnd = generatedStart + length;
  let state = batch.get(virtual);
  if (!state) {
    const generated = virtual.snapshot.getText(0, virtual.snapshot.getLength());
    state = {
      map: language.maps.get(virtual, sourceScript) as unknown as MutableMap,
      generated,
      sourceText: sourceScript.snapshot.getText(
        0,
        sourceScript.snapshot.getLength(),
      ),
      lineStarts: lineStartsOf(generated),
      ranges: new Map(),
      spans: authoredSpansOf(virtual as SpannedVirtualCode),
      pending: [],
    };
    batch.set(virtual, state);
  }
  const key = `${generatedStart}:${length}`;
  let target = placed.get(virtual)?.get(key);
  if (!target) {
    // Any authored mapping covering the range settles it, even one whose
    // `verification` rejects this diagnostic: that is a host deliberately
    // hiding a spurious error (the `.astro.mx` fence's TS1108), which Volar
    // keeps dropping. Only a range no mapping covers is unmapped. Overlays
    // are filtered out, so the lookup tables built for this call stay valid
    // while its overlays are pending.
    const map = state.map as unknown as {
      toSourceRange: (
        ...args: [number, number, boolean, (data: unknown) => boolean]
      ) => Iterable<unknown>;
    };
    for (const _ of map.toSourceRange(
      generatedStart,
      generatedEnd,
      true,
      (data) => !overlayData.has(data as object),
    )) {
      return diagnostic;
    }
  }

  const rangesKey = `${source}:${code}`;
  let ranges = state.ranges.get(rangesKey);
  if (!ranges) {
    ranges = reportedRanges(virtual.mappings, source, code);
    state.ranges.set(rangesKey, ranges);
  }
  if (!target) {
    target = enclosingSpan(
      state.spans,
      ranges,
      generatedStart,
      generatedEnd,
      state.generated.slice(generatedStart, generatedEnd).trim(),
      state.sourceText,
    );
    const data = { verification: true };
    overlayData.add(data);
    state.pending.push({
      sourceOffsets: [target.start],
      generatedOffsets: [generatedStart],
      lengths: [target.length],
      generatedLengths: [length],
      data,
    });
    const forCode = placed.get(virtual) ?? new Map();
    forCode.set(key, target);
    placed.set(virtual, forCode);
  }

  // The author's when they spelled its text where it came from, or when
  // mapped authored code is inside or directly next to its generated range
  // (per range, not per line); else code MX wrote.
  const authored =
    target.spelled ||
    ranges.some(
      (range) => range.start <= generatedEnd && range.end >= generatedStart,
    );
  const [line, column] = lineAndColumn(state.lineStarts, generatedStart);
  const suffix = !authored
    ? mxBugSuffix
    : state.spans
      ? approximateSuffix
      : unknownPositionSuffix;
  return {
    ...diagnostic,
    messageText: suffixed(diagnostic.messageText, suffix(line, column)),
  };
}

function approximateIn<T extends Diagnostic>(
  language: Language<string>,
  diagnostic: T,
  batch: Batch,
): T {
  const source = String(diagnostic.source);
  const code = String(diagnostic.code);
  const own = approximateLocated(language, diagnostic, source, code, batch);
  const related = diagnostic.relatedInformation;
  if (!related) return own;
  const mapped = related.map((entry) =>
    approximateLocated(language, entry, source, code, batch),
  );
  return mapped.every((entry, index) => entry === related[index])
    ? own
    : { ...own, relatedInformation: mapped };
}

/**
 * Every diagnostic of `diagnostics` through {@link approximateUnmapped}, as
 * one batch: each virtual code is read once and its source map changed once.
 */
export function approximateUnmappedAll<T extends Diagnostic>(
  language: Language<string>,
  diagnostics: readonly T[],
): T[] {
  const batch: Batch = new Map();
  const result = diagnostics.map((diagnostic) =>
    approximateIn(language, diagnostic, batch),
  );
  flush(batch);
  return result;
}

/**
 * `diagnostic`, or — when Volar could not map it back to the source — a copy
 * Volar can: the generated range is mapped onto the nearest enclosing authored
 * span (see {@link enclosingSpan}) and the message suffixed with
 * {@link approximateSuffix}, {@link unknownPositionSuffix} or
 * {@link mxBugSuffix}. The same goes for each of
 * its `relatedInformation` entries, which Volar would otherwise drop one by
 * one. An exactly mapped diagnostic is returned as the same object.
 */
export function approximateUnmapped<T extends Diagnostic>(
  language: Language<string>,
  diagnostic: T,
): T {
  return approximateUnmappedAll(language, [diagnostic])[0] as T;
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
        ? approximateUnmappedAll(language, diagnostics)
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
          diagnostics: approximateUnmappedAll(language, result.diagnostics),
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
