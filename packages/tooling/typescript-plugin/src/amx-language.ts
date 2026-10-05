import { convertToTSX } from "@astrojs/compiler/sync";
import { lowerAstroMx } from "@mxlang/astro/template";
import {
  type GeneratedMapping,
  type MxWarning,
  reportScanDiagnostics,
} from "@mxlang/core";
import {
  builtinLookup,
  defaultTagFor,
  resolveTargetPolicy,
  scanCached,
} from "@mxlang/target-registry";
import type { RawSourceMap } from "@mxlang/tsx-bridge";
import type {
  CodeInformation,
  CodeMapping,
  VirtualCode,
} from "@volar/language-core";
import type {} from "@volar/typescript";
import type * as ts from "typescript";
import { failedModuleStub } from "./failed-module-stub.ts";
import {
  fileKindForPipeline,
  fileKindHostFilter,
  fileKindOf,
} from "./file-kinds.ts";
import { createTargetPolicyRecorder } from "./host-policy-diagnostics.ts";
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

export const AMX_EXTENSION = `${fileKindForPipeline("astro-template").segment}.mx`;
export const AMX_LANGUAGE_ID =
  fileKindForPipeline("astro-template").languageIds?.[0] ??
  fileKindForPipeline("astro-template").diagnosticSource;

/**
 * TypeScript's "A 'return' statement can only be used within a function body."
 * The one code Astro's own language tools suppress for `.astro` (its
 * `isNoCantReturnOutsideFunction`, whose own TODO asks for a better TSX shape),
 * because a fence `return` is legal Astro.
 */
const CANT_RETURN_OUTSIDE_FUNCTION = 1108;

/**
 * Where the `---` fence ends, as an offset into the authored `.astro.mx` file.
 *
 * `.astro.mx` has no TS1108 problem at compile time: `lowerAstroMx` accepts the
 * fence's top-level `return` and copies the fence through. TS1108 comes from the
 * *editor projection* instead — `convertToTSX` (Astro's own compiler) emits the
 * frontmatter at the top level of a TSX module, ahead of the generated
 * component function, so TypeScript sees a module-level `return`. Astro's own
 * language server drops every 1108 for `.astro`; this narrows that to the fence
 * itself, so a 1108 anywhere else in the virtual file still reaches the author.
 *
 * The projection cannot simply wrap the fence in a function body instead: the
 * fence's imports and its top-level `const`s share module scope with the
 * template, so wrapping would strand the template's `${…}` references on
 * bindings it can no longer see.
 *
 * The filter works in *source* offsets because that is the space every surface
 * reports in: by the time a diagnostic reaches it, both the tsserver language
 * service and `mx-tsc`'s program have mapped it back to the author's own file.
 */
function fenceEndOffset(source: string): number | undefined {
  const fence = source.match(/^---\r?\n[\s\S]*?\r?\n---/);
  return fence ? fence[0].length : undefined;
}

/**
 * `codeInformation` for a span inside the `---` fence: identical, except that
 * TS1108 is not verified there.
 *
 * Volar applies `verification.shouldReport` to every diagnostic it maps back to
 * the source, in tsserver and inside `runTsc` alike, so this is the one seam
 * `mx-tsc --astro` has: it never holds the decorated program, and tsc's own
 * reporter prints whatever the program returns. The mappings are the fence
 * region, so a 1108 anywhere else in the file still reaches the author.
 *
 * Only this object form is new to Volar's readers, and the pinned
 * @volar/language-core 2.4.28 (`lib/editor.js`) reads it in two ways:
 * `isDiagnosticsEnabled` and `isCodeActionsEnabled` are both `!!verification`
 * (an object is truthy, so diagnostics and quick fixes stay on in the fence),
 * and `shouldReportDiagnostics` is the only reader of `shouldReport`. A Volar
 * that adds a required key to the object form must be revisited here.
 */
const fenceCodeInformation: CodeInformation = {
  ...codeInformation,
  verification: {
    shouldReport: (_source, code) =>
      Number(code) !== CANT_RETURN_OUTSIDE_FUNCTION,
  },
};

/**
 * Gives every mapping that lies wholly inside the fence `fenceCodeInformation`.
 *
 * Only single-span mappings are judged: `sourceOffsets[0]`/`lengths[0]` are the
 * whole mapping only when there is exactly one span, so any other shape is left
 * untouched (plain `codeInformation`) rather than guessed from span 0.
 * `composeAmxMappings` emits one span per mapping today.
 */
function withFenceVerification(
  mappings: CodeMapping[],
  fenceEnd: number,
): CodeMapping[] {
  if (fenceEnd === 0) return mappings;
  return mappings.map((mapping) => {
    if (mapping.sourceOffsets.length !== 1) return mapping;
    const start = mapping.sourceOffsets[0];
    const length = mapping.lengths[0];
    if (start === undefined || length === undefined) return mapping;
    return start + length <= fenceEnd
      ? { ...mapping, data: fenceCodeInformation }
      : mapping;
  });
}

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
  const fenceEnds = new Map<string, number>();
  const hostPolicies = createTargetPolicyRecorder();

  return {
    getLanguageId(fileName) {
      return isAmx(fileName) ? AMX_LANGUAGE_ID : undefined;
    },

    createVirtualCode(fileName, languageId, snapshot) {
      if (languageId !== AMX_LANGUAGE_ID && !isAmx(fileName)) return undefined;

      const source = snapshot.getText(0, snapshot.getLength());
      // Only for what it reports: this file's host is fixed by its extension.
      hostPolicies.resolve(fileName, source);
      try {
        // The same tags `@mxlang/astro`'s own Vite plugin discovers for this
        // file. Without them a tag that compiles under `astro build` is an
        // unknown tag in the editor and under `mx-tsc --astro` — the
        // asymmetry already closed for `.solid.mx`.
        //
        // A scan diagnostic names a different file (the `package.json`), so
        // it cannot become a positioned `MxCompileDiagnostic` here — logged
        // the same way `mx-language.ts`/`language.ts` already do.
        const scan = scanCached(fileName, {
          host: fileKindHostFilter(fileKindForPipeline("astro-template")),
        });
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
              defaultTag: defaultTagFor(
                fileName,
                resolveTargetPolicy(fileName, { quiet: true }),
              ),
              warnings,
              targets: builtinLookup(),
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
        const fenceEnd = fenceEndOffset(source) ?? 0;
        const mappings = withFenceVerification(
          composeAmxMappings(
            lowered.mappings,
            converted.map,
            converted.code,
            lowered.code,
          ),
          fenceEnd,
        );
        syntaxErrors.delete(fileName);
        fenceEnds.set(fileName, fenceEnd);
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
          fenceEnds.delete(fileName);
          // See `ForeignTemplateError`'s doc comment (`language.ts`) for the
          // map-clobber caveat this write is subject to.
          compileDiagnostics.set(foreign.templateFileName, [
            foreign.templateDiagnostic,
          ]);
          compileDiagnostics.set(fileName, [foreign.callerDiagnostic]);
          return createVirtualCode(
            typescript,
            failedModuleStub(typescript, source),
            [],
          );
        }
        const error = toSyntaxError(fileName, source, cause);
        syntaxErrors.set(fileName, error);
        fenceEnds.delete(fileName);
        compileDiagnostics.set(fileName, [{ ...error, category: "error" }]);
        return createVirtualCode(
          typescript,
          failedModuleStub(typescript, source),
          [],
        );
      }
    },

    getSyntaxError(fileName) {
      return syntaxErrors.get(fileName);
    },

    filterSemanticDiagnostics(fileName, diagnostics) {
      const fenceEnd = fenceEnds.get(fileName);
      if (fenceEnd === undefined || fenceEnd === 0) return [...diagnostics];
      return diagnostics.filter((diagnostic) => {
        const start = diagnostic.start;
        if (diagnostic.code !== CANT_RETURN_OUTSIDE_FUNCTION) return true;
        if (start === undefined) return true;
        return start >= fenceEnd;
      });
    },

    getCompileDiagnostics(fileName) {
      return [
        ...diagnosticsFrom(compileDiagnostics, fileName),
        ...hostPolicies.errors(fileName),
      ];
    },

    getTargetPolicyDiagnostics(fileName) {
      return hostPolicies.get(fileName);
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
 * Composes `.astro.mx` -> lowered `.astro` spans with Astro's `.astro` -> TSX map.
 * Only intersections represented by both stages survive.
 */
export function composeAmxMappings(
  amxToAstro: GeneratedMapping[],
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
  return fileKindOf(fileName)?.pipeline === "astro-template";
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
