/**
 * What the tools do with a dialect's files: recognise them, and check them.
 *
 * A dialect file is check-only in `mx-tsc`, the language server and the
 * TypeScript plugin: `lowerSource` parses, lowers and checks it under the
 * dialect's own syntax and tag rules, and its diagnostics are what the tools
 * report. No JavaScript is generated and no target is involved. This module
 * is the one place that does it, so the three tools cannot disagree.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type DialectManifest,
  discoverDialects,
  findMxConfig,
  isTranslateError,
  lowerSource,
  routeDialect,
} from "@mxlang/core";
import { moduleSegments } from "./index.ts";

/** What a tool shows for a diagnostic when no dialect owns the file. */
export const FALLBACK_DIAGNOSTIC_SOURCE = "mxlang";

/** One diagnostic of a dialect file, positioned in that file. */
export interface DialectDiagnostic {
  severity: "error" | "warning";
  message: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  column: number;
  /** UTF-16 code-unit offset in the file. */
  offset: number;
  /** The dialect's machine-readable code (`ctx.fail`'s `code`), when it gave one. */
  code?: string;
}

/** The result of checking one dialect file. */
export interface DialectCheck {
  /**
   * What the tools put in a diagnostic's `source`: the dialect's `name`, or
   * `"mxlang"` when the file claims no dialect that could be routed.
   */
  source: string;
  diagnostics: DialectDiagnostic[];
}

function nearestPackageJson(dir: string): string | undefined {
  let current = dir;
  for (;;) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) return candidate;
    if (basename(current) === "node_modules") return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The dialects the project around `dir` uses, or none when its manifests
 * cannot be read: an unreadable manifest is reported where the file is
 * checked, not here.
 */
function dialectsAround(dir: string): readonly DialectManifest[] {
  const manifest = nearestPackageJson(dir);
  if (manifest === undefined) return [];
  try {
    return discoverDialects(manifest);
  } catch {
    return [];
  }
}

/**
 * The file extensions the project around `dir` hands to dialects, each with
 * its leading dot: the ones its dialect packages claim, then the ones its
 * `mx.extensions` routes. A tool that must know which files to open before it
 * has seen one (a TypeScript program's file list, an editor's file watcher)
 * asks this. Empty when the project uses no dialect.
 */
export function dialectExtensions(dir: string): string[] {
  const dialects = dialectsAround(dir);
  if (dialects.length === 0) return [];
  const found = new Set(dialects.flatMap((dialect) => dialect.extensions));
  try {
    const routed = findMxConfig(dir)?.config?.extensions;
    if (routed && typeof routed === "object" && !Array.isArray(routed)) {
      for (const extension of Object.keys(routed)) found.add(extension);
    }
  } catch {
    // A malformed config is reported when a file is checked.
  }
  return [...found];
}

/** Whether `filePath` ends with an extension the project around it hands to a dialect. */
function claimsExtension(filePath: string): boolean {
  const name = basename(filePath);
  return dialectExtensions(dirname(filePath)).some(
    (extension) => name.length > extension.length && name.endsWith(extension),
  );
}

/**
 * The dialect that handles `filePath`, or `undefined` for an MX file and for
 * anything else. Never throws: a file whose routing is an error (two dialects
 * claim its extension, a manifest claims an extension MX owns) has no dialect
 * to name, and {@link checkDialectFile} reports the error.
 */
export function dialectOf(filePath: string): DialectManifest | undefined {
  try {
    return routeDialect(filePath, { hostSegments: moduleSegments() });
  } catch {
    return undefined;
  }
}

/**
 * Whether the tools treat `filePath` as a dialect file: it routes to a
 * dialect, or it is not an `.mx` file and the project hands its extension to
 * dialects without the routing settling which (two dialects claim it). The
 * second kind has no dialect to name, but it is no TypeScript or MX file
 * either, and {@link checkDialectFile} reports why.
 */
export function isDialectFile(filePath: string): boolean {
  return (
    dialectOf(filePath) !== undefined ||
    (!filePath.endsWith(".mx") && claimsExtension(filePath))
  );
}

/**
 * Checks a dialect file, or returns `undefined` when `filePath` is not one
 * (an MX file, or a file no dialect handles): the caller then does what it
 * always did, byte for byte.
 *
 * A diagnostic measured in another file (a dialect's package manifest, MX's
 * config) is placed at the start of this file and says where it really is,
 * as the tools report a tag template's: the editor and `tsc` print per file.
 *
 * A file the project hands to a dialect but whose routing fails (two
 * dialects claim its extension) has no dialect to name: the routing error is
 * reported under the fallback source. An `.mx` file whose routing fails is
 * left to the ordinary compile, which reports the same error.
 */
export function checkDialectFile(
  filePath: string,
  text: string,
): DialectCheck | undefined {
  let dialect: DialectManifest | undefined;
  try {
    dialect = routeDialect(filePath, { hostSegments: moduleSegments() });
  } catch (error) {
    if (filePath.endsWith(".mx") || !claimsExtension(filePath)) {
      return undefined;
    }
    if (!isTranslateError(error)) throw error;
    return {
      source: FALLBACK_DIAGNOSTIC_SOURCE,
      diagnostics: [
        elsewhere(
          error.message,
          error.line,
          error.column,
          error.file,
          filePath,
        ),
      ],
    };
  }
  if (dialect === undefined) return undefined;
  const { diagnostics } = lowerSource(text, filePath);
  return {
    source: dialect.name,
    diagnostics: diagnostics.map((diagnostic) => {
      if (diagnostic.file !== undefined && diagnostic.file !== filePath) {
        return {
          ...elsewhere(
            diagnostic.message,
            diagnostic.line,
            diagnostic.column,
            diagnostic.file,
            filePath,
          ),
          severity: diagnostic.severity,
          ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
        };
      }
      return {
        severity: diagnostic.severity,
        message: diagnostic.message,
        line: diagnostic.line,
        column: diagnostic.column,
        offset: diagnostic.offset,
        ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
      };
    }),
  };
}

/** An error measured in another file, as a diagnostic at the head of `filePath`. */
function elsewhere(
  message: string,
  line: number,
  column: number,
  file: string | undefined,
  filePath: string,
): DialectDiagnostic {
  const where =
    file === undefined || file === filePath
      ? ""
      : ` (in ${file}:${line}:${column + 1})`;
  return {
    severity: "error",
    message: `${message}${where}`,
    line: 1,
    column: 0,
    offset: 0,
  };
}
