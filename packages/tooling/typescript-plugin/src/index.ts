import type {} from "@volar/typescript";
import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin";
import type * as ts from "typescript";
import {
  type AmxLanguagePlugin,
  createAmxLanguagePlugin,
} from "./amx-language.ts";
import {
  type AstroLanguagePluginLoader,
  createAstroLanguagePlugin,
} from "./astro-language.ts";
import {
  createCompoundExtensionResolver,
  createNgMxLanguagePlugin,
  createSolidMxLanguagePlugin,
  type DependencySourceReader,
  isNgMx,
  type NgMxLanguagePlugin,
  type SolidMxLanguagePlugin,
} from "./language.ts";
import {
  createMxLanguagePlugin,
  type MxLanguagePlugin,
} from "./mx-language.ts";

type AnyMxLanguagePlugin =
  | SolidMxLanguagePlugin
  | NgMxLanguagePlugin
  | MxLanguagePlugin
  | AmxLanguagePlugin;

const pluginFactory: ts.server.PluginModuleFactory = (modules) => {
  let languagePlugins: Array<AnyMxLanguagePlugin> | undefined;
  const volarFactory = createLanguageServicePlugin((typescript, info) => {
    const readSource = createProjectSourceReader(info);
    const solidMxPlugin = createSolidMxLanguagePlugin(typescript, {
      readSource,
    });
    const mxPlugin = createMxLanguagePlugin(typescript, { readSource });
    const ngMxPlugin = createNgMxLanguagePlugin(typescript, { readSource });
    languagePlugins = [solidMxPlugin, ngMxPlugin, mxPlugin];
    if (info.config?.astro === true) {
      languagePlugins.push(createAmxLanguagePlugin(typescript, { readSource }));
    }
    return {
      languagePlugins: createConfiguredLanguagePlugins(
        typescript,
        info.config?.astro === true,
        undefined,
        languagePlugins,
      ),
    };
  });
  const pluginModule = volarFactory(modules);

  return {
    ...pluginModule,
    getExternalFiles(project, updateLevel) {
      return (
        pluginModule.getExternalFiles?.(project, updateLevel) ?? []
      ).filter(
        (fileName) =>
          fileName.endsWith(".solid.mx") ||
          isNgMx(fileName) ||
          fileName.endsWith(".mx") ||
          fileName.endsWith(".amx") ||
          fileName.endsWith(".astro"),
      );
    },
    create(info) {
      const service = pluginModule.create(info);
      return withSyntaxDiagnostics(
        modules.typescript,
        service,
        () => languagePlugins,
      );
    },
  };
};

/**
 * Reads a callee's text as the project holds it, so a caller compiles
 * against an open callee's unsaved buffer.
 *
 * It asks the project for the script it already has rather than the language
 * service host for a snapshot: Volar decorates the host's
 * `getScriptSnapshot` to return an MX file's *virtual* code, and asking the
 * host would also attach a file the project does not hold yet. A file the
 * project does not hold has no unsaved text, so core reading it from disk is
 * already right.
 */
function createProjectSourceReader(
  info: ts.server.PluginCreateInfo,
): DependencySourceReader {
  return (fileName) => {
    try {
      const snapshot = info.project.getScriptInfo(fileName)?.getSnapshot();
      return snapshot?.getText(0, snapshot.getLength());
    } catch {
      // `getSnapshot` throws on a file too large for the language service;
      // such a file is read from disk like any other the project lacks.
      return undefined;
    }
  };
}

export function createConfiguredLanguagePlugins(
  typescript: typeof ts,
  astro: boolean,
  loadAstro?: AstroLanguagePluginLoader,
  mxPlugins: Array<AnyMxLanguagePlugin> = [
    createSolidMxLanguagePlugin(typescript),
    createNgMxLanguagePlugin(typescript),
    createMxLanguagePlugin(typescript),
  ],
) {
  return [
    ...mxPlugins,
    ...(astro &&
    !mxPlugins.some(
      (plugin) => plugin.getLanguageId?.("component.amx") === "astromx",
    )
      ? [createAmxLanguagePlugin(typescript)]
      : []),
    ...(astro ? [createAstroLanguagePlugin(loadAstro)] : []),
    createCompoundExtensionResolver(typescript),
  ];
}

function withSyntaxDiagnostics(
  typescript: typeof ts,
  service: ts.LanguageService,
  getLanguagePlugins: () => Array<AnyMxLanguagePlugin> | undefined,
): ts.LanguageService {
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property !== "getSyntacticDiagnostics") {
        return Reflect.get(target, property, receiver);
      }

      return (fileName: string) => {
        const diagnostics = target.getSyntacticDiagnostics(fileName);
        const compileDiagnostics =
          getLanguagePlugins()?.flatMap((plugin) =>
            plugin.getCompileDiagnostics(fileName),
          ) ?? [];
        if (compileDiagnostics.length === 0) return diagnostics;

        return [
          ...diagnostics,
          ...compileDiagnostics.map((diagnostic) => ({
            file: typescript.createSourceFile(
              fileName,
              diagnostic.source,
              typescript.ScriptTarget.Latest,
              false,
              typescript.ScriptKind.TSX,
            ),
            start: diagnostic.offset,
            length: Math.min(1, diagnostic.source.length - diagnostic.offset),
            category:
              diagnostic.category === "error"
                ? typescript.DiagnosticCategory.Error
                : typescript.DiagnosticCategory.Warning,
            code: diagnostic.category === "error" ? 80001 : 80002,
            source: fileName.endsWith(".solid.mx")
              ? "solidmx"
              : isNgMx(fileName)
                ? "ngmx"
                : fileName.endsWith(".amx")
                  ? "amx"
                  : "mx",
            messageText: diagnostic.message,
          })),
        ];
      };
    },
  });
}

export {
  composeAmxMappings,
  createAmxLanguagePlugin,
} from "./amx-language.ts";
export { createAstroLanguagePlugin } from "./astro-language.ts";
export type {
  MxCompileDiagnostic,
  MxDiagnosticLanguagePlugin,
} from "./language.ts";
export {
  createCompoundExtensionResolver,
  createNgMxLanguagePlugin,
  createSolidMxLanguagePlugin,
} from "./language.ts";
export {
  createAstroTypeSurface,
  createHtmlMappings,
  createMxLanguagePlugin,
  type MxLanguagePluginOptions,
} from "./mx-language.ts";
export default pluginFactory;
