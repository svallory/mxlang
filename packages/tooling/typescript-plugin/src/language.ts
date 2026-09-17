import { decode } from "@jridgewell/sourcemap-codec";
import { getCustomTags } from "@mxlang/core";
import type { MxRegionCompile, RawSourceMap } from "@mxlang/parser";
import { print } from "@mxlang/parser";
import { compileSolidMx } from "@mxlang/solid";
import type {
  CodeInformation,
  CodeMapping,
  LanguagePlugin,
  VirtualCode,
} from "@volar/language-core";
import type {} from "@volar/typescript";
import type * as ts from "typescript";

/**
 * Adapts `compileSolidMx`'s own `(source, options)` signature to the
 * `MxRegionCompile` shape `print` calls — the parser no longer defaults to
 * this host, so every `.solid.mx` caller supplies it explicitly.
 */
export const solidRegionCompile: MxRegionCompile = ({ source, ...rest }) =>
  compileSolidMx(source, rest);

export const SOLID_MX_EXTENSION = "solid.mx";
export const SOLID_MX_LANGUAGE_ID = "solidmx";

export const codeInformation: CodeInformation = {
  verification: true,
  completion: true,
  semantic: true,
  navigation: true,
};

export interface SolidMxSyntaxError {
  fileName: string;
  message: string;
  offset: number;
  source: string;
}

export interface SolidMxLanguagePlugin extends LanguagePlugin<string> {
  getSyntaxError(fileName: string): SolidMxSyntaxError | undefined;
}

export function createSolidMxLanguagePlugin(
  typescript: typeof ts,
): SolidMxLanguagePlugin {
  const syntaxErrors = new Map<string, SolidMxSyntaxError>();

  return {
    getLanguageId(fileName) {
      return isSolidMx(fileName) ? SOLID_MX_LANGUAGE_ID : undefined;
    },

    createVirtualCode(fileName, languageId, snapshot) {
      if (languageId !== SOLID_MX_LANGUAGE_ID && !isSolidMx(fileName)) {
        return undefined;
      }

      const source = snapshot.getText(0, snapshot.getLength());
      try {
        // The tags this file can call, discovered the same way every other
        // integration discovers them. Without this the editor would know
        // nothing of a registered tag inside a `.solid.mx` region while a
        // `vite build` of the same file compiled it fine — the gap the P1
        // review recorded against this path.
        const discovered = getCustomTags(fileName, { host: "solid" });
        const printed = print(source, fileName, {
          mxRegionCompile: solidRegionCompile,
          ...(Object.keys(discovered).length > 0
            ? { customTags: discovered }
            : undefined),
        });
        syntaxErrors.delete(fileName);
        return createVirtualCode(typescript, printed.code, source, printed.map);
      } catch (cause) {
        syntaxErrors.set(fileName, toSyntaxError(fileName, source, cause));
        return createVirtualCode(typescript, "", source, undefined);
      }
    },

    getSyntaxError(fileName) {
      return syntaxErrors.get(fileName);
    },

    typescript: {
      resolveHiddenExtensions: true,
      extraFileExtensions: [
        {
          extension: SOLID_MX_EXTENSION,
          isMixedContent: false,
          scriptKind: typescript.ScriptKind.TSX,
        },
      ],
      getServiceScript(root) {
        return {
          code: root,
          extension: ".tsx",
          scriptKind: typescript.ScriptKind.TSX,
          preventLeadingOffset: true,
        };
      },
    },
  };
}

function createVirtualCode(
  typescript: typeof ts,
  generated: string,
  source: string,
  map: RawSourceMap | undefined,
): VirtualCode {
  return {
    id: "root",
    languageId: "typescriptreact",
    snapshot: typescript.ScriptSnapshot.fromString(generated),
    mappings: map ? decodeMappings(map, generated, source) : [],
    embeddedCodes: [],
  };
}

export function decodeMappings(
  map: RawSourceMap,
  generated: string,
  source: string,
): CodeMapping[] {
  const generatedLineOffsets = lineOffsets(generated);
  const sourceLineOffsets = lineOffsets(source);
  const rawMappings: CodeMapping[] = [];

  for (const [generatedLine, segments] of decode(map.mappings).entries()) {
    const generatedLineOffset = generatedLineOffsets[generatedLine];
    if (generatedLineOffset === undefined) continue;
    const nextLineOffset =
      generatedLineOffsets[generatedLine + 1] ?? generated.length;

    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx];
      if (segment === undefined || segment.length < 4) continue;
      const sourceLine = segment[2];
      const sourceColumn = segment[3];
      if (sourceLine === undefined || sourceColumn === undefined) continue;
      const sourceLineOffset = sourceLineOffsets[sourceLine];
      if (sourceLineOffset === undefined) continue;

      const generatedOffset = generatedLineOffset + segment[0];
      const sourceOffset = sourceLineOffset + sourceColumn;

      // Bound the span by the next segment's start or end of generated line.
      const nextSegGenCol = segments[segIdx + 1]?.[0];
      const maxGen =
        nextSegGenCol !== undefined
          ? generatedLineOffset + nextSegGenCol
          : nextLineOffset;
      const maxLength = maxGen - generatedOffset;

      const length = Math.min(
        maxLength,
        equalLength(generated, generatedOffset, source, sourceOffset),
      );
      if (length === 0) continue;

      rawMappings.push({
        sourceOffsets: [sourceOffset],
        generatedOffsets: [generatedOffset],
        lengths: [length],
        data: codeInformation,
      });
    }
  }

  return mergeMappings(rawMappings);
}

/**
 * Merges adjacent `CodeMapping`s whose generated and source spans are
 * contiguous (i.e. end-to-start with the same delta). This keeps the mapping
 * list compact for the common case where lines outside MX regions are
 * identity-mapped character by character by `@babel/generator`.
 */
export function mergeMappings(mappings: CodeMapping[]): CodeMapping[] {
  const merged: CodeMapping[] = [];

  for (const curr of mappings) {
    const prev = merged[merged.length - 1];
    // Every mapping this function is given has exactly one span, but the
    // `CodeMapping` type allows many, so read the first defensively rather
    // than asserting: a malformed entry should be passed through untouched,
    // not merged on a guessed offset.
    const prevGen = prev?.generatedOffsets[0];
    const prevSrc = prev?.sourceOffsets[0];
    const prevLen = prev?.lengths[0];
    const currGen = curr.generatedOffsets[0];
    const currSrc = curr.sourceOffsets[0];
    const currLen = curr.lengths[0];

    if (
      prev === undefined ||
      prevGen === undefined ||
      prevSrc === undefined ||
      prevLen === undefined ||
      currGen === undefined ||
      currSrc === undefined ||
      currLen === undefined ||
      prev.generatedLengths !== undefined ||
      curr.generatedLengths !== undefined ||
      currGen !== prevGen + prevLen ||
      currSrc !== prevSrc + prevLen
    ) {
      merged.push(curr);
      continue;
    }

    prev.lengths[0] = prevLen + currLen;
  }

  return merged;
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let offset = 0; offset < text.length; offset++) {
    if (text.charCodeAt(offset) === 10) offsets.push(offset + 1);
  }
  return offsets;
}

function equalLength(
  generated: string,
  generatedOffset: number,
  source: string,
  sourceOffset: number,
): number {
  let length = 0;
  while (
    generatedOffset + length < generated.length &&
    sourceOffset + length < source.length &&
    generated.charCodeAt(generatedOffset + length) ===
      source.charCodeAt(sourceOffset + length)
  ) {
    length++;
  }
  return length;
}

function isSolidMx(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(`.${SOLID_MX_EXTENSION}`);
}

function toSyntaxError(
  fileName: string,
  source: string,
  cause: unknown,
): SolidMxSyntaxError {
  const error = cause as {
    message?: string;
    loc?: { line?: number; column?: number; index?: number };
  };
  const line = Math.max(1, error.loc?.line ?? 1);
  const column = Math.max(0, error.loc?.column ?? 0);
  const lineStart = lineOffsets(source)[line - 1] ?? source.length;

  return {
    fileName,
    message: error.message ?? "Invalid SolidMX source.",
    offset: Math.min(source.length, error.loc?.index ?? lineStart + column),
    source,
  };
}

/**
 * Advertises the terminal `mx` suffix so TypeScript's module resolver can find
 * a `.solid.mx` file it was asked to import.
 *
 * Volar 2.4.28's resolver assumes a custom extension is one suffix. For
 * `X.solid.mx` TypeScript probes `X.solid.d.mx.ts`; declaring `mx` as an extra
 * extension lets that probe be redirected to the real source. Without it an
 * `import "./X.solid.mx"` is TS2307 even though the file compiles fine on its
 * own.
 *
 * This resolves nothing by itself — `getLanguageId` and `getServiceScript`
 * both return undefined, so no file is claimed. It exists purely to widen the
 * resolver, and is used by both the tsserver plugin and `mx-tsc` so an editor
 * and CI resolve imports the same way.
 */
export function createCompoundExtensionResolver(
  typescript: typeof ts,
): LanguagePlugin<string> {
  return {
    getLanguageId: () => undefined,
    typescript: {
      extraFileExtensions: [
        {
          extension: "mx",
          isMixedContent: false,
          scriptKind: typescript.ScriptKind.TSX,
        },
      ],
      getServiceScript: () => undefined,
    },
  };
}
