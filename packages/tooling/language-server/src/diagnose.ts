/**
 * The server's core function: compile one document under a resolved host
 * policy and turn the result into LSP diagnostics.
 *
 * Kept independent of any transport (stdio, in-process duplex) so it can be
 * tested directly, as the brief requires, without spawning a process.
 */

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import * as core from "@mxlang/core";
import {
  type CustomTag,
  dropOwnParserPosition,
  isTranslateError,
  type MxWarning,
  type ScanDiagnostic,
  type TargetPolicy,
  type TargetPolicyDiagnostic,
} from "@mxlang/core";
import { type PrintOptions, print } from "@mxlang/parser";
import {
  type BuiltinFileKind,
  builtinFileKinds,
  getCustomTags,
  lookupFor,
  scanCached,
} from "@mxlang/target-registry";
import {
  type Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver/node";

export type { TargetPolicy };

/** Policy diagnostics that say the selected target could not be loaded. */
const LOAD_FAILURE_CODES: ReadonlySet<string> = new Set([
  "target-not-found",
  "target-load-failed",
  "target-invalid-descriptor",
  "host-invalid-descriptor",
]);

export const SOLID_MX_LANGUAGE_IDS = new Set(
  builtinFileKinds
    .filter((kind) => kind.pipeline === "region")
    .flatMap((kind) => kind.languageIds ?? []),
);

/**
 * File kinds take precedence over page policy. Silent template suffixes keep
 * their case-insensitive match; region suffixes keep their exact match. A
 * region language id also identifies an untitled or mis-suffixed buffer, but
 * cannot override a silent template suffix. Silent kinds match suffixes only:
 * changing a page's language mode must never suppress its diagnostics.
 */
function fileKindOf(uri: string, languageId = ""): BuiltinFileKind | undefined {
  return (
    builtinFileKinds.find((kind) =>
      (kind.pipeline === "region" ? uri : uri.toLowerCase()).endsWith(
        `.${kind.segment}.mx`,
      ),
    ) ??
    builtinFileKinds.find(
      (kind) =>
        kind.pipeline === "region" && kind.languageIds?.includes(languageId),
    )
  );
}

export function isAstroMxDocument(filePath: string): boolean {
  return fileKindOf(filePath)?.pipeline === "astro-template";
}

export function isSolidMxDocument(uri: string, languageId = ""): boolean {
  return fileKindOf(uri, languageId)?.pipeline === "region";
}

/** The filesystem path a document URI names, for comparing with a `TranslateError`'s file. */
function filePathOf(uri: string): string {
  return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
}

/** The URI a diagnostic measured in a tag template is published against. */
function uriOf(filePath: string): string {
  return filePath.startsWith("file://")
    ? filePath
    : pathToFileURL(filePath).href;
}

/**
 * Diagnostics belonging to a file other than the one compiled.
 *
 * A tag template is compiled as part of its *caller*, so an error inside one
 * is measured in the template and has no honest position in the document the
 * editor asked about. `diagnoseDocument` collects those here so the server can
 * publish them against the template's own URI.
 */
export interface RelatedDiagnostics {
  uri: string;
  diagnostics: Diagnostic[];
}

/**
 * Turns collected warnings into diagnostics, routing each to its own file.
 *
 * A warning raised inside a tag template is measured there, exactly as an
 * error is, so it follows the same third-position rule: published against the
 * template's URI rather than at a meaningless line of the open document.
 */
function warningDiagnostics(
  warnings: readonly MxWarning[],
  uri: string,
  related?: RelatedDiagnostics[],
): Diagnostic[] {
  const own: Diagnostic[] = [];
  for (const warning of warnings) {
    const diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Warning,
      source: "mxlang",
      message: warning.message,
      range: {
        start: {
          line: Math.max(0, warning.line - 1),
          character: Math.max(0, warning.column),
        },
        end: {
          line: Math.max(0, warning.line - 1),
          character: Math.max(0, warning.column) + 1,
        },
      },
    };
    if (warning.file && warning.file !== filePathOf(uri)) {
      related?.push({ uri: uriOf(warning.file), diagnostics: [diagnostic] });
      continue;
    }
    own.push(diagnostic);
  }
  return own;
}

/**
 * How many code frames a message carries. One per Marko parser error, so a
 * callee reported as an aggregate carries every error's frame — while the
 * split message keeps only the first frame's reason.
 */
function frameCount(raw: string): number {
  return stripVTControlCharacters(raw)
    .split("\n")
    .filter((line) => /^[ \t]*> \d+ \|/.test(line)).length;
}

/**
 * Splits a compiler error into its compact text and its code frame.
 *
 * Babel/Marko errors read `<header>\n    at <path>:L:C\n      1 | <src>\n    > 2 | <src>\n        | ^^^ <text>\n      3 | ...`:
 * the error text rides on the caret line, the `at` line repeats what the
 * range already carries, and the optional header (for a wrapped callee error,
 * `` `<box>`: custom tag threw: ``) says where the error came from. The message
 * keeps the header plus that text (an agent pays for every token); the frame,
 * ANSI-free and dedented to its shallowest line, goes to `data.codeFrame`. The `at`
 * line is dropped only when it names `documentPath` itself; otherwise it is
 * returned resolved in `at`, so the caller can name and link the other file
 * (the cwd-relative `../..` form the compiler prints is never exposed). A
 * message with no frame, or a frame whose caret line carries no text, comes
 * back unchanged.
 */
export function splitCodeFrame(
  raw: string,
  documentPath?: string,
): {
  message: string;
  codeFrame?: string;
  at?: { file: string; line: number; column: number };
} {
  const plain = stripVTControlCharacters(raw);
  const lines = plain.split("\n");
  const marker = lines.findIndex((l) => /^\s*> \d+ \|/.test(l));
  if (marker < 0) return { message: raw };
  const caretAt = lines.findIndex(
    (l, i) => i > marker && /^\s*\|\s*\^+\s+\S/.test(l),
  );
  if (caretAt < 0) return { message: raw };
  const text = /^\s*\|\s*\^+\s+(\S.*)$/.exec(lines[caretAt] ?? "")?.[1];
  if (text === undefined) return { message: raw };

  // The frame starts at the first numbered line before the marker, walking
  // back over context lines; the `at` line, when present, sits just above.
  let start = marker;
  while (start > 0 && /^\s*\d+ \|/.test(lines[start - 1] ?? "")) start--;
  const atLine = start > 0 ? lines[start - 1] : undefined;
  const atMatch = atLine ? /^\s*at (.+):(\d+):(\d+)\s*$/.exec(atLine) : null;
  const headerEnd = atMatch ? start - 1 : start;
  let header = lines.slice(0, headerEnd).join(" ").replace(/\s+/g, " ").trim();
  if (documentPath && header.startsWith(`${documentPath}: `))
    header = header.slice(documentPath.length + 2);
  else if (documentPath && header === `${documentPath}:`) header = "";

  const frameLines = lines.slice(start, caretAt + 1);
  const indent = Math.min(
    ...frameLines.map((l) => /^\s*/.exec(l)?.[0].length ?? 0),
  );
  const codeFrame = lines
    .slice(start)
    .map((l) => (/^\s*$/.test(l.slice(0, indent)) ? l.slice(indent) : l))
    .join("\n")
    .trimEnd();

  let at: { file: string; line: number; column: number } | undefined;
  if (atMatch) {
    const file = resolve(atMatch[1] ?? "");
    if (!documentPath || file !== resolve(documentPath))
      at = { file, line: Number(atMatch[2]), column: Number(atMatch[3]) };
  }
  return {
    message: header ? `${header} ${text}` : text,
    codeFrame,
    ...(at ? { at } : {}),
  };
}

function errorPosition(
  error: unknown,
): { line: number; column: number; file?: string } | null {
  if (isTranslateError(error)) {
    return { line: error.line, column: error.column, file: error.file };
  }
  if (!error || typeof error !== "object") return null;

  const loc = (error as { loc?: unknown }).loc;
  if (!loc || typeof loc !== "object") return null;

  const direct = loc as { line?: unknown; column?: unknown };
  if (typeof direct.line === "number" && typeof direct.column === "number") {
    return { line: direct.line, column: direct.column };
  }

  const start = (loc as { start?: unknown }).start;
  if (!start || typeof start !== "object") return null;
  const nested = start as { line?: unknown; column?: unknown };
  if (typeof nested.line === "number" && typeof nested.column === "number") {
    return { line: nested.line, column: nested.column };
  }
  return null;
}

/** A filesystem path for `uri`, which may already be one. */
function documentPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

/**
 * Compiles or parses `text` for its document kind and returns the diagnostics
 * to publish for `uri`. Never throws: a positioned error becomes one Error
 * diagnostic; a successful run returns `[]`, which clears any previous
 * diagnostics; a locationless exception is reported via `onUnexpectedError`
 * and also returns `[]`.
 *
 * Supply the policy from `@mxlang/target-registry`'s `resolveTargetPolicy` or
 * `resolveTargetPolicyDetailed`. Those wrappers enforce tooling availability,
 * including staging/rejecting the data target. A hand-built policy bypasses
 * that staging: `{ target: "data" }` reaches the data compiler, not HTML or an
 * unwired-target fallback. Such direct dispatch is outside the supported
 * language-server policy path; this function does not re-resolve the policy.
 *
 * Custom tags are discovered from the document's own path (spec §4), so a
 * `<icon>` a `vite build` compiles is a `<icon>` the editor knows about too.
 * A sidecar that is broken — unparseable `parseOptions`, or a module that
 * throws while loading — fails the scan with a positioned `TranslateError`
 * naming that file, which lands here as an ordinary diagnostic rather than
 * taking the server down. That is why the scan is inside the `try`.
 */
export function diagnoseDocument(
  text: string,
  uri: string,
  hostPolicy: TargetPolicy,
  onUnexpectedError?: (error: unknown) => void,
  languageId = "",
  /**
   * Custom tags to use instead of scanning for them. Normally omitted: the
   * scan below is how a real document gets its tags.
   */
  explicitTags?: Record<string, CustomTag>,
  /**
   * Receives diagnostics that belong to a tag template rather than to `uri`.
   * Optional, so every existing caller is unchanged; the server passes one and
   * publishes whatever lands in it.
   */
  related?: RelatedDiagnostics[],
  /** Receives scan evidence files and callee/type files read for this document. */
  dependencies?: Set<string>,
  /**
   * What resolving `hostPolicy` had to say — the `diagnostics` of
   * `resolveTargetPolicyDetailed` (`@mxlang/core`): a malformed `package.json`,
   * an unknown `mx.host`. Each becomes a Warning on this document at 1:1,
   * worded `<package.json>:<line>:<col>: <message>` like the scan's (with
   * `relatedInformation` at the real range, and a copy pushed onto `related`
   * for the `package.json` URI), and is returned ahead of the
   * scan's and the compile's diagnostics (including when the compile itself
   * fails). Optional: omitting it (or passing `[]`) returns exactly what this
   * function returned before the parameter existed. `startServer` passes it.
   */
  hostPolicyDiagnostics?: readonly ScanDiagnostic[],
): Diagnostic[] {
  // Configuration problems the scan found. They are not fatal — a typo'd
  // `mx.tags` leaves the local `tags/` directories perfectly usable — so they
  // are collected here and returned alongside whatever the compile produces,
  // rather than replacing it.
  let scanWarnings: Diagnostic[] = (hostPolicyDiagnostics ?? []).map(
    (diagnostic) => scanDiagnosticToLsp(diagnostic, related),
  );
  // Positioned warnings the *compile* raised: content a tag template never
  // placed, an attribute tag a transform never read. A different source from
  // the scan's configuration warnings above, and routed per file below, since
  // one raised inside a template belongs to that template.
  const warnings: MxWarning[] = [];

  try {
    // Tag discovery is filesystem work, so it needs a path. `startServer`
    // already converts before calling, but this function is public and an
    // editor integration may hand it a `file://` URI directly — and
    // `resolve("file:///a/page.mx")` yields `<cwd>/file:/a/page.mx`, which
    // exists nowhere and silently discovers nothing. An untitled buffer has
    // no path at all; the walk then finds no `package.json` and returns an
    // empty map, which is correct.
    const path = documentPath(uri);
    // The filter value `mx.tags[].hosts` is matched against, read off the
    // target rather than taken from the policy's host: for a hostless target
    // (`html`) it is the target's legacy `mx.host` value, which is the string
    // every existing `hosts: ["html"]` entry already matches.
    // null means no restricted entry matches; undefined would disable filtering.
    // `lookupFor` adds the descriptor a package specifier under `mx.target`
    // loaded (§4.2), so a third-party host's name is a valid filter value.
    const lookup = lookupFor(hostPolicy);
    const host = lookup.hostFilterKey(hostPolicy.target) ?? null;
    const scan = scanCached(path, { host, targets: lookup });
    // Discovery reads contracts modules, sidecars and tag files independently
    // of the compiler's callee-input dependencies. Record them before compiling
    // so watcher-only edits reach callers even when compilation fails.
    for (const file of scan.files) dependencies?.add(file.path);
    scanWarnings = [
      ...scanWarnings,
      ...scan.diagnostics.map((diagnostic) =>
        scanDiagnosticToLsp(diagnostic, related),
      ),
    ];
    // Tags the caller supplied win over the scan's. Normally nothing is
    // supplied and discovery is the whole story; a caller that does pass a map
    // (a test, or an integration that scanned once for a batch of documents)
    // has already decided what this file sees, and re-scanning would either
    // overwrite that or silently merge two answers to one question.
    const discovered =
      explicitTags ?? getCustomTags(path, { host, targets: lookup });
    const customTags =
      Object.keys(discovered).length > 0 ? discovered : undefined;

    // A target that failed to load leaves the page under the fallback target.
    // That target's verdict on a page written for another one would only bury
    // the real error (§4.1), so report the policy and scan diagnostics alone.
    if (
      (hostPolicyDiagnostics ?? []).some((diagnostic) =>
        LOAD_FAILURE_CODES.has((diagnostic as { code?: string }).code ?? ""),
      )
    ) {
      return scanWarnings;
    }

    const kind = fileKindOf(path, languageId);
    if (
      kind?.pipeline === "astro-template" ||
      kind?.pipeline === "ng-template"
    ) {
      // Template diagnostics belong to mx-tsc and the TS plugin, never the
      // page compiler. Configuration diagnostics still reach the author.
      return scanWarnings;
    }
    if (kind?.pipeline === "region") {
      const compileRegion = kind.compileRegion;
      if (!compileRegion) return scanWarnings;
      // A language id can identify an untitled/mis-suffixed buffer. Supply
      // the registered suffix so the parser opts into its region bridge.
      const suffix = `.${kind.segment}.mx`;
      const filename = path.endsWith(suffix) ? path : `${path}${suffix}`;
      const result = print(text, filename, {
        customTags,
        mxRegionCompile: (input) => {
          const regionInput = { ...input, warnings, targets: lookup };
          // Core keeps the parser's hoisted AST nodes opaque to avoid a
          // dependency cycle. This built-in pipeline supplies parser nodes.
          return compileRegion(input.source, regionInput) as ReturnType<
            NonNullable<PrintOptions["mxRegionCompile"]>
          >;
        },
      });
      for (const dependency of result.dependencies)
        dependencies?.add(dependency);
    } else {
      const descriptor = lookup.target(hostPolicy.target);
      const load = descriptor?.load;
      // An unwired page target stays silent (D4); never guess a compiler.
      if (!load) return scanWarnings;
      const result = load(core).compileModule(text, path, {
        strict: descriptor.strict === "always" || hostPolicy.strict === true,
        customTags,
        warnings,
        targets: lookup,
      });
      for (const dependency of result.dependencies)
        dependencies?.add(dependency);
    }
    // A compile that succeeded may still have dropped something the author
    // wrote. Those are Warnings rather than Errors, and they are the reason
    // the core collects them instead of printing: a build's stdout is not
    // where an author is looking.
    return [...scanWarnings, ...warningDiagnostics(warnings, uri, related)];
  } catch (error) {
    // A failing scan carries partial discovery inputs and the previous
    // complete scan's evidence. A failing compile can likewise have resolved
    // real callees before raising an error. Both must retain watcher edges
    // even though no ScanResult or CompileResult was returned.
    if (isTranslateError(error)) {
      for (const dependency of error.dependencies ?? [])
        dependencies?.add(dependency);
    }
    const position = errorPosition(error);
    if (position) {
      // Babel/core lines are 1-based and columns are 0-based. LSP positions
      // are 0-based on both axes.
      const line = Math.max(0, position.line - 1);
      const column = Math.max(0, position.column);
      // These errors carry only a start position, not a span, so synthesize a
      // one-character range that marks where the error occurred.
      const raw =
        error instanceof Error
          ? error.message
          : String((error as { message?: unknown }).message ?? error);
      const split = splitCodeFrame(raw, filePathOf(uri));
      const { codeFrame, at } = split;
      // Babel's 0-based `(L:C)` is dropped only when it repeats this position
      // (same rule as the TypeScript plugin, so the surfaces agree).
      split.message = dropOwnParserPosition(error, split.message);
      // A wrapped callee parse error has no `file` of its own: its real
      // location lives only in the frame's `at` line. Name it, and link it.
      const callee = at && !position.file ? at : undefined;
      // Only the first frame's reason reaches the message, and a client that
      // renders neither `data` nor `relatedInformation` sees just that — so
      // say how many further errors the frame holds, on the callee
      // diagnostic and on the caller's pointer alike.
      const extraFrames = frameCount(raw) - 1;
      const summary =
        extraFrames > 0
          ? `${split.message} (+${extraFrames} more)`
          : split.message;
      const message = callee
        ? // 1-based already: this column is read out of Marko's own
          // `at <path>:L:C` frame header, and the related-information range
          // below subtracts 1 to reach an LSP (0-based) character.
          `${summary} (in ${callee.file}:${callee.line}:${callee.column})`
        : summary;
      const diagnostic: Diagnostic = {
        severity: DiagnosticSeverity.Error,
        source: "mxlang",
        message,
        ...(codeFrame === undefined ? {} : { data: { codeFrame } }),
        ...(callee
          ? {
              relatedInformation: [
                {
                  location: {
                    uri: uriOf(callee.file),
                    range: {
                      start: {
                        line: Math.max(0, callee.line - 1),
                        character: Math.max(0, callee.column - 1),
                      },
                      end: {
                        line: Math.max(0, callee.line - 1),
                        character: Math.max(0, callee.column),
                      },
                    },
                  },
                  message: summary,
                },
              ],
            }
          : {}),
        range: {
          start: { line, character: column },
          end: { line, character: column + 1 },
        },
      };
      // The third position rule (custom tags spec §2): an error raised inside
      // an inlined tag template is measured in *that* file, so publishing it
      // against the open document would underline whatever the caller happens
      // to have on that line. It is published against the template's own URI
      // at its real position (through `related`), and the open document gets a
      // pointer at its head so an author is not left with a compile that fails
      // for no visible reason.
      if (position.file && position.file !== filePathOf(uri)) {
        related?.push({
          uri: uriOf(position.file),
          diagnostics: [diagnostic],
        });
        return [
          ...scanWarnings,
          {
            ...diagnostic,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            message: `${message} (in ${position.file}:${position.line}:${position.column + 1})`,
            relatedInformation: [
              {
                location: {
                  uri: uriOf(position.file),
                  range: diagnostic.range,
                },
                message,
              },
            ],
          },
        ];
      }
      return [...scanWarnings, diagnostic];
    }

    onUnexpectedError?.(error);
    return scanWarnings;
  }
}

/**
 * Turns one scan diagnostic into an LSP one against the *open* document.
 *
 * The problem is in a `package.json`, not in the file the author is editing,
 * and LSP publishes diagnostics per document. Its line:column are
 * `package.json`'s, so they mean nothing in the document: the document gets
 * the warning at 1:1, whose message names `package.json:line:column`
 * (1-based, like `mx-tsc`'s `file(line,col)`) and whose `relatedInformation`
 * points at the real spot. The same problem is also pushed onto `related`, so
 * the server publishes it against the `package.json` URI at its real range,
 * for clients that show diagnostics on that file. Scan problems and existing
 * host diagnostics remain warnings; invalid targets and mismatches are errors,
 * with value lengths and the mismatch's related host position.
 */
function scanDiagnosticToLsp(
  diagnostic: ScanDiagnostic | TargetPolicyDiagnostic,
  related?: RelatedDiagnostics[],
): Diagnostic {
  const line = Math.max(0, diagnostic.line - 1);
  const column = Math.max(0, diagnostic.column);
  const range = {
    start: { line, character: column },
    end: {
      line,
      character:
        column +
        (("length" in diagnostic ? diagnostic.length : undefined) ?? 1),
    },
  };
  const uri = uriOf(diagnostic.file);
  const severity =
    "severity" in diagnostic && diagnostic.severity === "error"
      ? DiagnosticSeverity.Error
      : DiagnosticSeverity.Warning;
  const information =
    "relatedInformation" in diagnostic
      ? (diagnostic.relatedInformation?.map((entry) => ({
          location: {
            uri: uriOf(entry.file),
            range: {
              start: { line: entry.line - 1, character: entry.column },
              end: {
                line: entry.line - 1,
                character: entry.column + entry.length,
              },
            },
          },
          message: entry.message,
        })) ?? [])
      : [];
  // Core's message usually opens with the file's own path, which the prefix
  // below already states: keep one.
  const own = `${diagnostic.file} `;
  const text = diagnostic.message.startsWith(own)
    ? diagnostic.message.slice(own.length)
    : diagnostic.message;
  related?.push({
    uri,
    diagnostics: [
      {
        severity,
        source: "mxlang",
        message: diagnostic.message,
        range,
        ...(information.length ? { relatedInformation: information } : {}),
      },
    ],
  });
  return {
    severity,
    source: "mxlang",
    message: `${diagnostic.file}:${line + 1}:${column + 1}: ${text}`,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    relatedInformation: [
      { location: { uri, range }, message: text },
      ...information,
    ],
  };
}
