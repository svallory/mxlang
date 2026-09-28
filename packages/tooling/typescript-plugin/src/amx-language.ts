import { convertToTSX } from "@astrojs/compiler/sync";
import {
  type AstroTemplateMapping,
  lowerAstroMx,
} from "@mxlang/astro/template";
import {
  type MxWarning,
  reportScanDiagnostics,
  scanCached,
} from "@mxlang/core";
import type { RawSourceMap } from "@mxlang/parser";
import type { CodeMapping, VirtualCode } from "@volar/language-core";
import type {} from "@volar/typescript";
import type * as ts from "typescript";
import {
  codeInformation,
  compileWithDependencies,
  type DependencyLanguagePluginOptions,
  decodeMappings,
  diagnosticsFrom,
  foreignTemplateError,
  type MxCompileDiagnostic,
  type MxDiagnosticLanguagePlugin,
  mergeMappings,
  warningDiagnostic,
} from "./language.ts";
import type { MxSyntaxError } from "./mx-language.ts";

export const AMX_EXTENSION = "amx";
export const AMX_LANGUAGE_ID = "astromx";

export interface AmxLanguagePlugin extends MxDiagnosticLanguagePlugin {
  getSyntaxError(fileName: string): MxSyntaxError | undefined;
}

/** Lowers an AstroMX document and composes its two source-map stages. */
export function createAmxLanguagePlugin(
  typescript: typeof ts,
  options: DependencyLanguagePluginOptions = {},
): AmxLanguagePlugin {
  const syntaxErrors = new Map<string, MxSyntaxError>();
  const compileDiagnostics = new Map<string, MxCompileDiagnostic[]>();
  const dependencies = new Map<string, string[]>();
  const reportedScanDiagnostics = new Set<string>();

  return {
    getLanguageId(fileName) {
      return isAmx(fileName) ? AMX_LANGUAGE_ID : undefined;
    },

    createVirtualCode(fileName, languageId, snapshot) {
      if (languageId !== AMX_LANGUAGE_ID && !isAmx(fileName)) return undefined;

      const source = snapshot.getText(0, snapshot.getLength());
      try {
        // The same tags `@mxlang/astro`'s own Vite plugin discovers for this
        // file. Without them a tag that compiles under `astro build` is an
        // unknown tag in the editor and under `mx-tsc --astro` — the
        // asymmetry already closed for `.solid.mx`.
        //
        // A scan diagnostic names a different file (the `package.json`), so
        // it cannot become a positioned `MxCompileDiagnostic` here — logged
        // the same way `mx-language.ts`/`language.ts` already do.
        const scan = scanCached(fileName, { host: "astro" });
        reportScanDiagnostics(scan.diagnostics, reportedScanDiagnostics, (d) =>
          console.warn(`@mxlang/typescript-plugin: ${d.file}: ${d.message}`),
        );
        const discovered = scan.customTags;
        const result = compileWithDependencies(
          options.readSource,
          dependencies.get(fileName) ?? [],
          () => {
            const warnings: MxWarning[] = [];
            const lowered = lowerAstroMx(source, fileName, {
              ...(Object.keys(discovered).length > 0
                ? { customTags: discovered }
                : undefined),
              warnings,
            });
            return { ...lowered, warnings };
          },
        );
        const { warnings, ...lowered } = result;
        dependencies.set(fileName, lowered.dependencies);
        const converted = convertToTSX(lowered.code, {
          filename: fileName,
          sourcemap: "external",
        });
        const mappings = composeAmxMappings(
          lowered.mappings,
          converted.map,
          converted.code,
          lowered.code,
        );
        syntaxErrors.delete(fileName);
        compileDiagnostics.set(
          fileName,
          warnings.map((warning) =>
            warningDiagnostic(fileName, source, warning),
          ),
        );
        return createVirtualCode(typescript, converted.code, mappings);
      } catch (cause) {
        const foreign = foreignTemplateError(
          cause,
          fileName,
          source,
          options.readSource,
        );
        if (foreign) {
          syntaxErrors.delete(fileName);
          // See `ForeignTemplateError`'s doc comment (`language.ts`) for the
          // map-clobber caveat this write is subject to.
          compileDiagnostics.set(foreign.templateFileName, [
            foreign.templateDiagnostic,
          ]);
          compileDiagnostics.set(fileName, [foreign.callerDiagnostic]);
          return createVirtualCode(typescript, "", []);
        }
        const error = toSyntaxError(fileName, source, cause);
        syntaxErrors.set(fileName, error);
        compileDiagnostics.set(fileName, [{ ...error, category: "error" }]);
        return createVirtualCode(typescript, "", []);
      }
    },

    getSyntaxError(fileName) {
      return syntaxErrors.get(fileName);
    },

    getCompileDiagnostics(fileName) {
      return diagnosticsFrom(compileDiagnostics, fileName);
    },

    typescript: {
      resolveHiddenExtensions: true,
      extraFileExtensions: [
        {
          extension: AMX_EXTENSION,
          isMixedContent: false,
          scriptKind: typescript.ScriptKind.TSX,
        },
      ],
      getServiceScript(root) {
        return {
          code: root,
          extension: ".tsx",
          scriptKind: typescript.ScriptKind.TSX,
          // Like whole-file MX, Astro's generated TSX has a different line
          // table. Let Volar pad it against the author's source positions.
        };
      },
    },
  };
}

/**
 * Composes `.amx` -> lowered `.astro` spans with Astro's `.astro` -> TSX map.
 * Only intersections represented by both stages survive.
 */
export function composeAmxMappings(
  amxToAstro: AstroTemplateMapping[],
  astroToTsxMap: { mappings: string },
  tsx: string,
  astro: string,
): CodeMapping[] {
  const astroToTsx = decodeMappings(astroToTsxMap as RawSourceMap, tsx, astro);
  const composed: CodeMapping[] = [];

  for (const first of amxToAstro) {
    const sourceLength = first.sourceEnd - first.sourceStart;
    const astroLength = first.generatedEnd - first.generatedStart;

    for (const second of astroToTsx) {
      const secondSource = second.sourceOffsets[0];
      const secondGenerated = second.generatedOffsets[0];
      const secondLength = second.lengths[0];
      if (
        secondSource === undefined ||
        secondGenerated === undefined ||
        secondLength === undefined
      ) {
        continue;
      }

      const overlapStart = Math.max(first.generatedStart, secondSource);
      const overlapEnd = Math.min(
        first.generatedEnd,
        secondSource + secondLength,
      );
      if (overlapEnd <= overlapStart) continue;

      const overlapLength = overlapEnd - overlapStart;
      const generatedStart = secondGenerated + (overlapStart - secondSource);
      if (sourceLength === astroLength) {
        composed.push({
          sourceOffsets: [
            first.sourceStart + (overlapStart - first.generatedStart),
          ],
          generatedOffsets: [generatedStart],
          lengths: [overlapLength],
          data: codeInformation,
        });
        continue;
      }

      // A transformed hoist (notably `static const` -> `const`) is deliberately
      // a whole-block mapping. Keep it only when Astro preserved that complete
      // generated block; a partial intersection cannot be mapped honestly.
      if (
        overlapStart === first.generatedStart &&
        overlapEnd === first.generatedEnd
      ) {
        composed.push({
          sourceOffsets: [first.sourceStart],
          generatedOffsets: [generatedStart],
          lengths: [sourceLength],
          generatedLengths: [astroLength],
          data: codeInformation,
        });
      }
    }
  }

  return mergeMappings(
    composed.sort(
      (left, right) =>
        (left.generatedOffsets[0] ?? 0) - (right.generatedOffsets[0] ?? 0),
    ),
  );
}

function createVirtualCode(
  typescript: typeof ts,
  generated: string,
  mappings: CodeMapping[],
): VirtualCode {
  return {
    id: "root",
    languageId: "typescriptreact",
    snapshot: typescript.ScriptSnapshot.fromString(generated),
    mappings,
    embeddedCodes: [],
  };
}

function isAmx(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(`.${AMX_EXTENSION}`);
}

function toSyntaxError(
  fileName: string,
  source: string,
  cause: unknown,
): MxSyntaxError {
  const error = cause as {
    message?: string;
    line?: number;
    column?: number;
    loc?: {
      line?: number;
      column?: number;
      start?: { line?: number; column?: number };
    };
  };
  const line = Math.max(
    1,
    error.line ?? error.loc?.line ?? error.loc?.start?.line ?? 1,
  );
  const column = Math.max(
    0,
    error.column ?? error.loc?.column ?? error.loc?.start?.column ?? 0,
  );
  const lineStart = lineOffsets(source)[line - 1] ?? source.length;
  return {
    fileName,
    message: error.message ?? "Invalid AstroMX source.",
    offset: Math.min(source.length, lineStart + column),
    source,
  };
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let offset = 0; offset < text.length; offset++) {
    if (text.charCodeAt(offset) === 10) offsets.push(offset + 1);
  }
  return offsets;
}
