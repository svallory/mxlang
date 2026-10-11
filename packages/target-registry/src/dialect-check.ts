/**
 * What the tools do with a dialect's files: recognise them, and check them.
 *
 * A dialect file is check-only in `mx-tsc`, the language server and the
 * TypeScript plugin: `lowerSource` parses, lowers and checks it under the
 * dialect's own syntax and tag rules, and its diagnostics are what the tools
 * report. No JavaScript is generated and no target is involved. This module
 * is the one place that does it, so the three tools cannot disagree.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type DialectEmit,
  type DialectManifest,
  discoverDialects,
  emitFor,
  findMxConfig,
  isTranslateError,
  lowerSource,
  reservedExtensionReason,
  routeDialect,
  type ScanResult,
  tagFileDependencies,
} from "@mxlang/core";
import { moduleSegments, scanCached } from "./index.ts";

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
  /** A machine-readable code, when there is one: the dialect's (`ctx.fail`'s `code`) or core's warning code (`MX_DUPLICATE_ATTRIBUTE`). */
  code?: string;
  /**
   * Where the problem really is, when it is not in the checked file: a tag
   * file's own error, a dialect manifest's field error, a misplaced tag
   * file. `line` and `column` here are measured in `file` (1-based and
   * 0-based). The diagnostic's own `line`, `column` and `offset` are then the
   * head of the checked file (1, 0, 0) and its `message` ends with
   * `(in <file>:<line>:<column>)`, so a tool that paints per file never
   * underlines what the author has at that spot in the checked file. A tool
   * that can address the other file (an editor) shows the diagnostic there.
   */
  origin?: { file: string; line: number; column: number };
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
 * What the project around `dir` hands to dialects. `dialects` is empty when
 * its manifests cannot be read. A manifest that is invalid in another field (a
 * bad `tagDirs`) still says which extensions it claims: `rawClaims` lists the
 * `mx.dialect.extensions` and `tagExtensions` of the `package.json` that holds
 * it, so the files it claims are still recognised as dialect files and the
 * manifest's error is shown on them, instead of the file being taken for
 * nothing. A list core would itself refuse claims nothing.
 */
interface DialectsAround {
  dialects: readonly DialectManifest[];
  rawClaims: readonly string[];
}

function dialectsAround(dir: string): DialectsAround {
  const manifest = nearestPackageJson(dir);
  if (manifest === undefined) return { dialects: [], rawClaims: [] };
  try {
    return { dialects: discoverDialects(manifest), rawClaims: [] };
  } catch (error) {
    if (!isTranslateError(error)) return { dialects: [], rawClaims: [] };
    return {
      dialects: [],
      rawClaims: [
        ...new Set(
          [manifest, error.file].flatMap((file) =>
            file === undefined ? [] : rawDialectExtensions(file),
          ),
        ),
      ],
    };
  }
}

/** Is `value` written as a file extension (`.mesh.mx`)? Core's own check. */
const EXTENSION_SHAPE = /^(?:\.[^./\\\s]+)+$/;

/**
 * The extensions `file` (a `package.json`) lists under `mx.dialect.extensions`
 * and `mx.dialect.tagExtensions`, read without validating the rest of the
 * manifest. A list is used only when core would accept it: an array of dotted
 * extensions, none reserved (`.ts`, `.mx`), none twice; a `tagExtensions`
 * entry may not repeat an `extensions` one either. Anything else claims
 * nothing, so an invalid claim never takes the files of another tool. Nothing
 * for a file that is no JSON or declares no dialect.
 */
function rawDialectExtensions(file: string): string[] {
  let dialect: { extensions?: unknown; tagExtensions?: unknown } | undefined;
  try {
    dialect = (
      JSON.parse(readFileSync(file, "utf8")) as {
        mx?: { dialect?: { extensions?: unknown; tagExtensions?: unknown } };
      }
    ).mx?.dialect;
  } catch {
    return [];
  }
  const accepted = (list: unknown): string[] | undefined => {
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const hostSegments = moduleSegments();
    for (const entry of list) {
      if (
        typeof entry !== "string" ||
        !EXTENSION_SHAPE.test(entry) ||
        reservedExtensionReason(entry, hostSegments) !== undefined
      ) {
        return undefined;
      }
    }
    return new Set(list).size === list.length ? (list as string[]) : undefined;
  };
  const extensions = accepted(dialect?.extensions);
  if (extensions === undefined) return [];
  const tagExtensions = accepted(dialect?.tagExtensions) ?? [];
  return tagExtensions.some((entry) => extensions.includes(entry))
    ? extensions
    : [...extensions, ...tagExtensions];
}

/**
 * The file extensions the project around `dir` hands to dialects, each with
 * its leading dot: the ones its dialect packages claim (`extensions`, then
 * `tagExtensions`), then the ones its `mx.extensions` routes. A tool that must
 * know which files to open before it has seen one (a TypeScript program's file
 * list, an editor's file watcher) asks this. Empty when the project uses no
 * dialect. A tag file is a dialect file like any other, so a `tagExtensions`
 * entry that no claimed extension ends (`.concept`) is listed: the program
 * checks that file as it checks one named `.thing.probe`, and the editor
 * watches it.
 *
 * A dialect whose manifest is invalid in another field still lists the
 * extensions it names, so its files are recognised and show the manifest's
 * error.
 */
export function dialectExtensions(dir: string): string[] {
  const { dialects, rawClaims } = dialectsAround(dir);
  if (dialects.length === 0) return [...rawClaims];
  const found = new Set(
    dialects.flatMap((dialect) => [
      ...dialect.extensions,
      ...(dialect.tagExtensions ?? []),
    ]),
  );
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

/**
 * {@link dialectExtensions} over a whole project tree: the extensions the
 * dialects declared by `root`'s own package and by every package below it
 * claim. A project's files are not all in the package that holds its
 * `tsconfig.json`: in a workspace a dialect is declared by a member package,
 * and a tool that lists a program's file types from the `tsconfig`'s
 * directory must still hear of it. `node_modules` and dot-directories are not
 * walked, and neither are symbolic links.
 *
 * Which file a dialect handles is still decided per file ({@link isDialectFile}),
 * so a sibling package that declares no dialect leaves its own `.probe` file
 * alone.
 */
export function dialectExtensionsUnder(root: string): string[] {
  const found = new Set(dialectExtensions(root));
  const visit = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = join(dir, entry.name);
      if (existsSync(join(child, "package.json"))) {
        for (const extension of dialectExtensions(child)) found.add(extension);
      }
      visit(child);
    }
  };
  visit(root);
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

/** What a tool that builds `filePath` gets from the file's dialect: see {@link emitOf}. */
export interface BuildEmit {
  /**
   * The dialect's `name` (`MX` for MX's own files), or `"mxlang"` when the
   * project hands the file's extension to dialects without the routing
   * settling which (two dialects claim it, or a manifest is invalid).
   */
  name: string;
  /** The dialect's emit, `undefined` when it registers none. */
  emit: DialectEmit | undefined;
  /** False for the unsettled case above: no dialect has a name to give. */
  settled: boolean;
}

/**
 * Asks the dialect of `filePath` for its emit, with the host file kinds of
 * the built-in targets reserved (`emitFor`). A tool that builds a file calls
 * this and runs the emit, or refuses the file when there is none; it never
 * picks a target for a dialect's file.
 *
 * Throws the routing error for a file that is no `.mx` file and that the
 * project does not hand to dialects either: it is nothing this module
 * serves, and the caller decides what a failed route means for it.
 */
export function emitOf(filePath: string): BuildEmit {
  try {
    const found = emitFor(filePath, { hostSegments: moduleSegments() });
    return { name: found.dialect.name, emit: found.emit, settled: true };
  } catch (error) {
    if (!isTranslateError(error) || !claimsExtension(filePath)) throw error;
    return {
      name: FALLBACK_DIAGNOSTIC_SOURCE,
      emit: undefined,
      settled: false,
    };
  }
}

/**
 * Whether the tools treat `filePath` as a dialect file: it routes to a
 * dialect, or it is not an `.mx` file and the project hands its extension to
 * dialects without the routing settling which (two dialects claim it, or a
 * manifest is invalid). The second kind has no dialect to name, but it is no
 * TypeScript or MX file either, and {@link checkDialectFile} reports why.
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
 * dialects claim its extension, or a dialect manifest is invalid in a field)
 * has no dialect to name: the routing error is reported under the fallback
 * source. An `.mx` file whose routing fails is
 * left to the ordinary compile, which reports the same error.
 */
export function checkDialectFile(
  filePath: string,
  text: string,
  /**
   * Receives the files the check read: tag files, contracts modules, sidecars
   * and the manifests and configs the scan read, and what the hooks of the
   * tag files the check called read (`ctx.dependsOn`, and the tag files those
   * called). A tool that re-checks a file when one of them changes (the
   * language server) passes a set.
   */
  dependencies?: Set<string>,
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
          "error",
          error.diagnosticCode,
        ),
      ],
    };
  }
  if (dialect === undefined) return undefined;
  // The project's tags reach a dialect file as they reach an MX file: core
  // never discovers them on its own, so a contract (`mx.contracts`) or a local
  // `tags/` template is checked only if it is handed over here. A dialect
  // file has no target, so no `mx.tags[].hosts` restriction applies to it.
  let scan: ScanResult;
  try {
    scan = scanCached(filePath, { host: null });
  } catch (error) {
    if (!isTranslateError(error)) throw error;
    for (const dependency of error.dependencies ?? []) {
      dependencies?.add(dependency);
    }
    return {
      source: dialect.name,
      diagnostics: [
        elsewhere(
          error.message,
          error.line,
          error.column,
          error.file,
          filePath,
          "error",
          error.diagnosticCode,
        ),
      ],
    };
  }
  for (const file of scan.files) dependencies?.add(file.path);
  for (const file of scan.packageFiles) dependencies?.add(file);
  for (const file of scan.configFiles ?? []) dependencies?.add(file);
  const customTags =
    Object.keys(scan.customTags).length > 0 ? scan.customTags : undefined;
  const { diagnostics } = lowerSource(text, filePath, { customTags });
  // The lowering derived the contracts of the tags it called, and a hook
  // may have read files the scan never saw.
  for (const file of tagFileDependencies(scan.files.map((f) => f.path))) {
    dependencies?.add(file);
  }
  return {
    source: dialect.name,
    diagnostics: [
      ...scan.diagnostics.map((diagnostic) => ({
        ...elsewhere(
          diagnostic.message,
          diagnostic.line,
          diagnostic.column,
          diagnostic.file,
          filePath,
          diagnostic.severity ?? "warning",
          diagnostic.code,
        ),
      })),
      ...diagnostics.map((diagnostic) => {
        if (diagnostic.file !== undefined && diagnostic.file !== filePath) {
          return {
            ...elsewhere(
              diagnostic.message,
              diagnostic.line,
              diagnostic.column,
              diagnostic.file,
              filePath,
              diagnostic.severity,
              diagnostic.code,
            ),
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
    ],
  };
}

/**
 * A problem measured in another file, as a diagnostic at the head of
 * `filePath` that names where it is ({@link DialectDiagnostic.origin}).
 */
function elsewhere(
  message: string,
  line: number,
  column: number,
  file: string | undefined,
  filePath: string,
  severity: "error" | "warning" = "error",
  code?: string,
): DialectDiagnostic {
  const other = file !== undefined && file !== filePath;
  return {
    severity,
    message: other ? `${message} (in ${file}:${line}:${column + 1})` : message,
    line: 1,
    column: 0,
    offset: 0,
    ...(code === undefined ? {} : { code }),
    ...(other ? { origin: { file, line, column } } : {}),
  };
}
