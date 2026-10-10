import {
  checkDialectFile,
  dialectExtensions,
  isDialectFile,
} from "@mxlang/targets/dialect-check";
import type { VirtualCode } from "@volar/language-core";
import type {} from "@volar/typescript";
import type * as ts from "typescript";
import type {
  MxCompileDiagnostic,
  MxDiagnosticLanguagePlugin,
} from "./language.ts";

export const DIALECT_LANGUAGE_ID = "mx-dialect";

/**
 * What TypeScript sees of a dialect file. A dialect file is checked, never
 * compiled: it has no TypeScript projection, so its virtual module is empty
 * and every diagnostic comes from the dialect's own check.
 */
const DIALECT_MODULE = "export {};\n";

/**
 * The language plugin for the files dialects claim. It answers before the
 * `.mx` plugins, so a dialect's `.probe.mx` is the dialect's file and not an
 * MX file. For any file that is not a dialect file it answers nothing, and the
 * plugins after it behave exactly as they did without it.
 *
 * `extensions` are the dotted extensions the project hands to dialects
 * (`dialectExtensions`), which TypeScript must be told about before it lists a
 * program's files; `.mx` itself is the MX plugin's.
 */
export function createDialectLanguagePlugin(
  typescript: typeof ts,
  extensions: readonly string[] = [],
): MxDiagnosticLanguagePlugin {
  const compileDiagnostics = new Map<string, MxCompileDiagnostic[]>();
  const claimed = extensions.filter((extension) => extension !== ".mx");

  return {
    getLanguageId(fileName) {
      // The cheap suffix test first: TypeScript asks this of every file of a
      // program, and routing a path costs a manifest lookup.
      return claimed.some((extension) => fileName.endsWith(extension)) &&
        isDialectFile(fileName)
        ? DIALECT_LANGUAGE_ID
        : undefined;
    },

    createVirtualCode(fileName, languageId, snapshot) {
      if (languageId !== DIALECT_LANGUAGE_ID) return undefined;
      const source = snapshot.getText(0, snapshot.getLength());
      const check = checkDialectFile(fileName, source);
      if (check === undefined) return undefined;
      compileDiagnostics.set(
        fileName,
        check.diagnostics.map((diagnostic) => ({
          fileName,
          message: diagnostic.message,
          offset: diagnostic.offset,
          source,
          category: diagnostic.severity,
          diagnosticSource: check.source,
          ...(diagnostic.code === undefined
            ? {}
            : { diagnosticCode: diagnostic.code }),
        })),
      );
      return {
        id: "root",
        languageId: "typescript",
        snapshot: typescript.ScriptSnapshot.fromString(DIALECT_MODULE),
        mappings: [],
        embeddedCodes: [],
      } satisfies VirtualCode;
    },

    getCompileDiagnostics(fileName) {
      return fileName === undefined
        ? [...compileDiagnostics.values()].flat()
        : (compileDiagnostics.get(fileName) ?? []);
    },

    typescript: {
      extraFileExtensions: extensions
        .filter((extension) => extension !== ".mx")
        .map((extension) => ({
          extension: extension.replace(/^\./, ""),
          isMixedContent: false,
          scriptKind: typescript.ScriptKind.TS,
        })),
      getServiceScript(root) {
        return {
          code: root,
          extension: ".ts",
          scriptKind: typescript.ScriptKind.TS,
        };
      },
    },
  };
}

/**
 * The dotted extensions the project around `dir` hands to dialects, for a
 * tool that must name them before it has seen a file (`mx-tsc`'s list of the
 * file types a program may hold). Empty when the project uses no dialect.
 */
export function dialectFileExtensions(dir: string): string[] {
  return dialectExtensions(dir);
}
