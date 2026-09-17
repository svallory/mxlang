import { convertToTSX } from "@astrojs/compiler/sync";
import {
  type AstroTemplateMapping,
  lowerAstroMx,
} from "@mxlang/astro/template";
import { getCustomTags } from "@mxlang/core";
import type { RawSourceMap } from "@mxlang/parser";
import type {
  CodeMapping,
  LanguagePlugin,
  VirtualCode,
} from "@volar/language-core";
import type {} from "@volar/typescript";
import type * as ts from "typescript";
import { codeInformation, decodeMappings, mergeMappings } from "./language.ts";
import type { MxSyntaxError } from "./mx-language.ts";

export const AMX_EXTENSION = "amx";
export const AMX_LANGUAGE_ID = "astromx";

export interface AmxLanguagePlugin extends LanguagePlugin<string> {
  getSyntaxError(fileName: string): MxSyntaxError | undefined;
}

/** Lowers an AstroMX document and composes its two source-map stages. */
export function createAmxLanguagePlugin(
  typescript: typeof ts,
): AmxLanguagePlugin {
  const syntaxErrors = new Map<string, MxSyntaxError>();

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
        const discovered = getCustomTags(fileName, { host: "astro" });
        const lowered = lowerAstroMx(
          source,
          fileName,
          Object.keys(discovered).length > 0
            ? { customTags: discovered }
            : undefined,
        );
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
        return createVirtualCode(typescript, converted.code, mappings);
      } catch (cause) {
        syntaxErrors.set(fileName, toSyntaxError(fileName, source, cause));
        return createVirtualCode(typescript, "", []);
      }
    },

    getSyntaxError(fileName) {
      return syntaxErrors.get(fileName);
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
