import {
  checkDialectFile,
  dialectExtensionsUnder,
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
      if (!claimed.some((extension) => fileName.endsWith(extension))) {
        return undefined;
      }
      // The extension list is the project's: the union over every package in
      // it. A file of a package whose own dialects do not claim it is not
      // checked, but TypeScript has been told to list its extension, so it
      // must be answered here or the program would hold a file nothing can
      // read. A `.mx`-ending one is an MX file in that package: the MX plugins
      // answer it.
      return isDialectFile(fileName) || !fileName.endsWith(".mx")
        ? DIALECT_LANGUAGE_ID
        : undefined;
    },

    createVirtualCode(fileName, languageId, snapshot) {
      if (languageId !== DIALECT_LANGUAGE_ID) return undefined;
      const source = snapshot.getText(0, snapshot.getLength());
      // `undefined` for a file the project lists but no dialect of its package
      // claims: nothing to check, and no diagnostics.
      const check = checkDialectFile(fileName, source) ?? {
        source: "",
        diagnostics: [],
      };
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
 * The dotted extensions the project rooted at `dir` hands to dialects: those
 * of its own package and of every package below it, for a tool that must name
 * them before it has seen a file (`mx-tsc`'s list of the file types a program
 * may hold, the language service's file types). Empty when the project uses no
 * dialect.
 */
export function dialectFileExtensions(dir: string): string[] {
  return dialectExtensionsUnder(dir);
}
