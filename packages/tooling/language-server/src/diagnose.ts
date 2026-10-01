/**
 * The server's core function: compile one document under a resolved host
 * policy and turn the result into LSP diagnostics.
 *
 * Kept independent of any transport (stdio, in-process duplex) so it can be
 * tested directly, as the brief requires, without spawning a process.
 */

import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type CustomTag,
  getCustomTags,
  type HostPolicy,
  hostModuleSegment,
  type MxWarning,
  type ScanDiagnostic,
  scanCached,
  TranslateError,
} from "@mxlang/core";
import { compileHonoMx } from "@mxlang/hono";
import { compile } from "@mxlang/html";
import { print } from "@mxlang/parser";
import { compilePreactMx } from "@mxlang/preact";
import { compileReactMx } from "@mxlang/react";
import { compileSolidMx, compileSolidUnit } from "@mxlang/solid";
import {
  type Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver/node";

export type { HostPolicy };

export const SOLID_MX_LANGUAGE_IDS = new Set(["solidmx", "SolidMX"]);

/**
 * Whether `filePath` is an Angular host module (`x.ng.mx`). Case-insensitive,
 * like the TS plugin's `isNgMx`, which lowercases before matching.
 */
function isNgMxDocument(filePath: string): boolean {
  return hostModuleSegment(basename(filePath).toLowerCase()) === "ng";
}

export function isSolidMxDocument(uri: string, languageId = ""): boolean {
  return uri.endsWith(".solid.mx") || SOLID_MX_LANGUAGE_IDS.has(languageId);
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
 * Resolves a `HostPolicy` to the `strict` flag the translator compiles under.
 *
 * Solid, Preact and React documents take their own compiler path before this
 * function is called. Astro is always strict; HTML follows the resolved
 * policy.
 */
function resolveStrict(hostPolicy: HostPolicy): boolean {
  if (hostPolicy.host === "astro") return true;
  return hostPolicy.strict ?? false;
}

function errorPosition(
  error: unknown,
): { line: number; column: number; file?: string } | null {
  if (error instanceof TranslateError) {
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

/**
 * Compiles or parses `text` for its document kind and returns the diagnostics
 * to publish for `uri`. Never throws: a positioned error becomes one Error
 * diagnostic; a successful run returns `[]`, which clears any previous
 * diagnostics; a locationless exception is reported via `onUnexpectedError`
 * and also returns `[]`.
 *
 * Custom tags are discovered from the document's own path (spec §4), so a
 * `<icon>` a `vite build` compiles is a `<icon>` the editor knows about too.
 * A sidecar that is broken — unparseable `parseOptions`, or a module that
 * throws while loading — fails the scan with a positioned `TranslateError`
 * naming that file, which lands here as an ordinary diagnostic rather than
 * taking the server down. That is why the scan is inside the `try`.
 */
/** A filesystem path for `uri`, which may already be one. */
function documentPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

export function diagnoseDocument(
  text: string,
  uri: string,
  hostPolicy: HostPolicy,
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
  /** Receives every callee/type file read while compiling this document. */
  dependencies?: Set<string>,
  /**
   * What resolving `hostPolicy` had to say — the `diagnostics` of
   * `resolveHostPolicyDetailed` (`@mxlang/core`): a malformed `package.json`,
   * an unknown `mx.host`. Each becomes a Warning on this document, worded
   * `<package.json>: <message>` like the scan's, and is returned ahead of the
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
    scanDiagnosticToLsp,
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
    const scan = scanCached(path, { host: hostPolicy.host });
    scanWarnings = [
      ...scanWarnings,
      ...scan.diagnostics.map(scanDiagnosticToLsp),
    ];
    // Tags the caller supplied win over the scan's. Normally nothing is
    // supplied and discovery is the whole story; a caller that does pass a map
    // (a test, or an integration that scanned once for a batch of documents)
    // has already decided what this file sees, and re-scanning would either
    // overwrite that or silently merge two answers to one question.
    const discovered =
      explicitTags ?? getCustomTags(path, { host: hostPolicy.host });
    const customTags =
      Object.keys(discovered).length > 0 ? discovered : undefined;

    if (isNgMxDocument(path)) {
      // Deliberately silent, and checked FIRST: routed by file kind before
      // any host branch, as `mx-tsc`'s `isNgMx` does. A `.ng.mx` is an
      // Angular host module whatever `mx.host` says (an unknown host resolves
      // to a derived or default one, a `react`/`solid` host is simply the
      // wrong host for this file), so it must never reach another host's
      // compile. Angular documents are checked by `mx-tsc` and the TS plugin
      // (template diagnostics need `@angular/compiler-cli`, which the server
      // never loads); reporting "not wired" as an Error was a false positive
      // on every file. Host-policy warnings from the resolution still reach
      // the author via `scanWarnings` below.
    } else if (isSolidMxDocument(uri, languageId)) {
      // `parse` is the Vite path's whole-file parser and the cheapest public
      // entry that discovers every MX region. A language id can identify an
      // untitled/mis-suffixed buffer, so give that case the suffix that turns
      // the parser's opt-in MX bridge on.
      const filename = uri.endsWith(".solid.mx") ? uri : `${uri}.solid.mx`;
      const result = print(text, filename, {
        customTags,
        mxRegionCompile: (input) =>
          compileSolidMx(input.source, { ...input, warnings }),
      });
      for (const dependency of result.dependencies)
        dependencies?.add(dependency);
    } else if (hostPolicy.host === "solid") {
      // A whole-file `.mx` document routed to the Solid host. Unlike an
      // embedded `.solid.mx` region — a fragment spliced into someone
      // else's module — a whole-file unit is a module of its own, so it
      // goes through `compileSolidUnit`, not the region compiler
      // (decision 115); its declarations reject stateful Marko tags the
      // same way either compiler does, so there is no looser Solid policy
      // to select.
      const result = compileSolidUnit(text, {
        filename: uri,
        customTags,
        warnings,
      });
      for (const dependency of result.dependencies)
        dependencies?.add(dependency);
    } else if (hostPolicy.host === "preact") {
      // A whole-file `.mx` document routed to the Preact host. Its
      // declarations reject Marko's stateful tags outright, so like Solid's
      // there is no looser policy to select — the `strict` flag has no
      // meaning for this host and is not consulted.
      const result = compilePreactMx(text, uri, { customTags, warnings });
      for (const dependency of result.dependencies)
        dependencies?.add(dependency);
    } else if (hostPolicy.host === "react") {
      const result = compileReactMx(text, uri, { customTags, warnings });
      for (const dependency of result.dependencies)
        dependencies?.add(dependency);
    } else if (hostPolicy.host === "hono") {
      const result = compileHonoMx(text, uri, { customTags, warnings });
      for (const dependency of result.dependencies)
        dependencies?.add(dependency);
    } else if (hostPolicy.host === "angular") {
      // Same silence for an Angular-host `.mx` page; see the `.ng.mx` branch.
    } else {
      // Through `@mxlang/html`'s own front door, not `compileSource`
      // directly: this registers the host taglib and compiles via the IR.
      const result = compile(text, uri, {
        strict: resolveStrict(hostPolicy),
        customTags,
        warnings,
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
    // A failing compile can still have resolved real callees before the
    // error was raised (e.g. "missing required attribute tag" is only
    // reachable after reading the callee's declaration) — those are still
    // this document's dependencies, and the re-diagnosis graph must keep the
    // edge even though this compile produced no `CompileResult`.
    if (error instanceof TranslateError) {
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
      const message =
        error instanceof Error
          ? error.message
          : String((error as { message?: unknown }).message ?? error);
      const diagnostic: Diagnostic = {
        severity: DiagnosticSeverity.Error,
        source: "mxlang",
        message,
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
            message: `${message} (in ${position.file})`,
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
 * and LSP publishes diagnostics per document — so the message names the file
 * rather than the range pointing at it. A warning rather than an error,
 * because the scan carried on and everything else in the package still
 * compiles; the author has a misconfigured entry, not a broken file.
 */
function scanDiagnosticToLsp(diagnostic: ScanDiagnostic): Diagnostic {
  const line = Math.max(0, diagnostic.line - 1);
  const column = Math.max(0, diagnostic.column);
  return {
    severity: DiagnosticSeverity.Warning,
    source: "mxlang",
    message: `${diagnostic.file}: ${diagnostic.message}`,
    range: {
      start: { line, character: column },
      end: { line, character: column + 1 },
    },
  };
}
