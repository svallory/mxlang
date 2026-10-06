import {
  type CodeMapping,
  type Language,
  type LanguagePlugin,
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
 * can map: the nearest mapped span, with the message suffixed by
 * {@link approximateSuffix}. A diagnostic Volar can map is returned as the
 * very same object, so exact positions and messages never change.
 *
 * Both tools run the same function: `mx-tsc` through the program Volar
 * decorates, the tsserver plugin through the language service Volar proxies.
 */

/** The text appended to the message of a diagnostic reported approximately. */
export function approximateSuffix(line: number, column: number): string {
  return ` (position approximate: generated ${line}:${column})`;
}

type Diagnostic = ts.Diagnostic;

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

interface GeneratedRange {
  start: number;
  end: number;
}

/** Every generated range a diagnostic-reporting mapping covers. */
function reportedRanges(
  mappings: readonly CodeMapping[],
  source: string,
  code: string,
): GeneratedRange[] {
  const ranges: GeneratedRange[] = [];
  for (const mapping of mappings) {
    if (!shouldReportDiagnostics(mapping.data, source, code)) continue;
    mapping.generatedOffsets.forEach((start, index) => {
      const length =
        mapping.generatedLengths?.[index] ?? mapping.lengths[index] ?? 0;
      ranges.push({ start, end: start + length });
    });
  }
  return ranges;
}

/**
 * The generated range whose source span stands in for an unmappable offset:
 * the tightest mapped range containing it, else the nearest one before it (the
 * generated module follows source order, so that is the construct being
 * emitted), else the first one after it.
 */
function nearestRange(
  ranges: readonly GeneratedRange[],
  offset: number,
): GeneratedRange | undefined {
  let containing: GeneratedRange | undefined;
  let before: GeneratedRange | undefined;
  let after: GeneratedRange | undefined;
  for (const range of ranges) {
    if (range.start <= offset && offset <= range.end) {
      if (
        !containing ||
        range.end - range.start < containing.end - containing.start
      ) {
        containing = range;
      }
    } else if (range.end < offset) {
      if (!before || range.end > before.end) before = range;
    } else if (!after || range.start < after.start) {
      after = range;
    }
  }
  return containing ?? before ?? after;
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
 * `diagnostic`, or — when Volar could not map it back to the source — a copy
 * Volar can: moved onto the nearest mapped span of the generated module and
 * suffixed with {@link approximateSuffix}. A module with no mapped span at all
 * puts it at the file start (1:1) through the anchor mapping
 * {@link anchorEmptyMappings} adds; `tsc` cannot print a diagnostic that has a
 * file but no position.
 */
export function approximateUnmapped<T extends Diagnostic>(
  language: Language<string>,
  diagnostic: T,
): T {
  const { file, start, length } = diagnostic;
  if (!file || start === undefined || length === undefined) return diagnostic;
  const found = serviceScriptOf(language, file.fileName);
  if (!found) return diagnostic;
  const { serviceScript } = found;

  const source = String(diagnostic.source);
  const code = String(diagnostic.code);
  const sourceScript = language.scripts.fromVirtualCode(serviceScript.code);
  const leading = serviceScript.preventLeadingOffset
    ? 0
    : sourceScript.snapshot.getLength();
  const generatedStart = start - leading;
  const map = language.maps.get(serviceScript.code, sourceScript);
  // Any mapping covering the range settles it, even one whose `verification`
  // rejects this diagnostic: that is a host deliberately hiding a spurious
  // error (the `.astro.mx` fence's TS1108), which Volar keeps dropping. Only
  // a range no mapping covers is unmapped.
  for (const _ of map.toSourceRange(
    generatedStart,
    generatedStart + length,
    true,
    () => true,
  )) {
    return diagnostic;
  }

  const snapshot = serviceScript.code.snapshot;
  const [line, column] = lineAndColumn(
    snapshot.getText(0, snapshot.getLength()),
    generatedStart,
  );
  const messageText = suffixed(
    diagnostic.messageText,
    approximateSuffix(line, column),
  );
  const nearest = nearestRange(
    reportedRanges(serviceScript.code.mappings, source, code),
    generatedStart,
  );
  if (!nearest) {
    // No mapped span at all: the file's start, which `anchorEmptyMappings`
    // gave an empty module a zero-length mapping for.
    return { ...diagnostic, start: leading, length: 0, messageText };
  }
  return {
    ...diagnostic,
    start: leading + nearest.start,
    length: nearest.end - nearest.start,
    messageText,
  };
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

/**
 * The mapping that lets a diagnostic land at the file start (1:1) when a
 * module has no mapped span of its own (a failed compile's stub, an empty
 * template): zero-length, generated offset 0 to source offset 0.
 */
const ANCHOR: CodeMapping = {
  sourceOffsets: [0],
  generatedOffsets: [0],
  lengths: [0],
  generatedLengths: [0],
  data: { verification: true },
};

function anchored<T extends VirtualCode>(code: T | undefined): T | undefined {
  if (code && code.mappings.length === 0) {
    code.mappings = [ANCHOR];
  }
  return code;
}

/**
 * Gives every virtual code a plugin creates or updates with no mapping at all
 * the {@link ANCHOR} mapping, so {@link approximateUnmapped} has a span to put
 * a diagnostic on. Mutates the plugins' two hooks in place; a code that has
 * any mapping is untouched.
 */
export function anchorEmptyMappings<P extends LanguagePlugin<string>>(
  plugins: P[],
): P[] {
  for (const plugin of plugins) {
    const { createVirtualCode, updateVirtualCode } = plugin;
    if (createVirtualCode) {
      plugin.createVirtualCode = (...args) =>
        anchored(createVirtualCode.apply(plugin, args));
    }
    if (updateVirtualCode) {
      plugin.updateVirtualCode = (...args) =>
        anchored(updateVirtualCode.apply(plugin, args)) as VirtualCode;
    }
  }
  return plugins;
}
