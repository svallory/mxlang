import { dirname, join } from "node:path";
import { builtinFileKinds } from "@mxlang/targets";
import { isDialectFile } from "@mxlang/targets/dialect-check";
import type { Language } from "@volar/language-core";
import type {} from "@volar/typescript";
import { createLanguageServicePlugin } from "@volar/typescript/lib/quickstart/createLanguageServicePlugin";
import { createResolveModuleName } from "@volar/typescript/lib/resolveModuleName";
import type * as ts from "typescript";
import { ambientTypeDiagnostics, withAmbientTypes } from "./ambient-types.ts";
import {
  AMX_EXTENSION,
  AMX_LANGUAGE_ID,
  type AmxLanguagePlugin,
  createAmxLanguagePlugin,
} from "./amx-language.ts";
import {
  type AstroLanguagePluginLoader,
  createAstroLanguagePlugin,
} from "./astro-language.ts";
import { diagnosticCodeOf, mxCodeFixes } from "./code-fixes.ts";
import {
  createDialectLanguagePlugin,
  dialectFileExtensions,
} from "./dialect-language.ts";
import {
  HOST_POLICY_DIAGNOSTIC_CODE,
  hostPolicyMessage,
} from "./host-policy-diagnostics.ts";
import {
  createCompoundExtensionResolver,
  createNgMxLanguagePlugin,
  createRegionLanguagePlugin,
  type DependencySourceReader,
  isNgMx,
  type MxDiagnosticLanguagePlugin,
  type NgMxLanguagePlugin,
  type SolidMxLanguagePlugin,
} from "./language.ts";
import {
  createMxLanguagePlugin,
  MX_LANGUAGE_ID,
  type MxLanguagePlugin,
} from "./mx-language.ts";
import {
  angularDiagnostics,
  createNgDiagnosticsService,
  type NgDiagnosticsService,
} from "./ng-diagnostics.ts";
import { createTsconfigPathsResolver } from "./tsconfig-paths.ts";
import {
  approximateUnmappedDiagnostics,
  LANGUAGE_SERVICE_DIAGNOSTIC_METHODS,
} from "./unmapped-diagnostics.ts";

function createBuiltinLanguagePlugins(
  typescript: typeof ts,
  readSource?: DependencySourceReader,
  onCompiled?: import("./language.ts").NgMxLanguagePluginOptions["onCompiled"],
  projectDir?: string,
  resolveImport?: import("./tsconfig-paths.ts").TsPathsImportResolver,
): Array<AnyMxLanguagePlugin> {
  // First, so a dialect's `.probe.mx` is the dialect's file; it answers
  // nothing for any other file.
  const plugins: Array<AnyMxLanguagePlugin> = [
    createDialectLanguagePlugin(
      typescript,
      projectDir === undefined ? [] : dialectFileExtensions(projectDir),
    ),
  ];
  for (const kind of builtinFileKinds) {
    switch (kind.pipeline) {
      case "region":
        plugins.push(
          createRegionLanguagePlugin(typescript, kind, { readSource }),
        );
        break;
      case "ng-template":
        plugins.push(
          createNgMxLanguagePlugin(typescript, { readSource, onCompiled }),
        );
        break;
      case "astro-template":
        // Opt-in composition is handled by createConfiguredLanguagePlugins.
        break;
    }
  }
  plugins.push(
    createMxLanguagePlugin(typescript, { readSource, resolveImport }),
  );
  return plugins;
}

type AnyMxLanguagePlugin =
  | MxDiagnosticLanguagePlugin
  | SolidMxLanguagePlugin
  | NgMxLanguagePlugin
  | MxLanguagePlugin
  | AmxLanguagePlugin;

const pluginFactory: ts.server.PluginModuleFactory = (modules) => {
  let languagePlugins: Array<AnyMxLanguagePlugin> | undefined;
  let ngDiagnostics: NgDiagnosticsService | undefined;
  const volarFactory = createLanguageServicePlugin((typescript, info) => {
    // The hosts' ambient declaration files, as `mx-tsc` adds them. A host
    // whose `ambientTypes` throws is reported project-wide, with the
    // compiler-option diagnostics, and the project goes on without its files.
    const ambientErrors: string[] = [];
    withAmbientTypes(
      info.languageServiceHost,
      () =>
        info.project.projectKind === typescript.server.ProjectKind.Configured
          ? dirname(info.project.getProjectName())
          : info.project.getCurrentDirectory(),
      ambientErrors,
    );
    const compilerOptionsDiagnostics =
      info.languageService.getCompilerOptionsDiagnostics.bind(
        info.languageService,
      );
    info.languageService.getCompilerOptionsDiagnostics = () => [
      ...compilerOptionsDiagnostics(),
      ...ambientTypeDiagnostics(typescript, ambientErrors),
    ];
    // Beneath Volar's proxy, so a diagnostic Volar cannot map is moved onto
    // the nearest mapped span before it would be dropped.
    // Volar proxies `info.languageService` right after this callback returns.
    let language: Language<string> | undefined;
    approximateUnmappedDiagnostics(
      info.languageService,
      LANGUAGE_SERVICE_DIAGNOSTIC_METHODS,
      () => language,
    );
    const readSource = createProjectSourceReader(info);
    ngDiagnostics = createEditorNgDiagnostics(typescript, info);
    languagePlugins = createBuiltinLanguagePlugins(
      typescript,
      readSource,
      (entry) => ngDiagnostics?.notifyCompiled(entry),
      projectDirectory(typescript, info),
      // The project's own compiler options decide alias resolution, so a
      // tsconfig `paths` entry reaches `.mx` callee imports exactly as it
      // reaches every other import the program resolves.
      createTsconfigPathsResolver(typescript, () =>
        info.languageServiceHost.getCompilationSettings(),
      ),
    );
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
      setup: (volarLanguage) => {
        language = volarLanguage;
        resolveWholeFileAliases(
          typescript,
          info.languageServiceHost,
          volarLanguage,
        );
      },
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
          fileName.endsWith(".mx") ||
          isNgMx(fileName) ||
          fileName.endsWith(".astro") ||
          isDialectFile(fileName),
      );
    },
    create(info) {
      const service = pluginModule.create(info);
      return withSyntaxDiagnostics(
        modules.typescript,
        service,
        () => languagePlugins,
        () => ngDiagnostics,
      );
    },
  };
};

/**
 * Volar delegates extensionless specifiers to tsserver's stock resolver.
 * Retry unresolved imports from whole-file MX callers with Volar's own
 * resolver, so exact aliases and extension-omitted paths find the same
 * virtual module as an explicit `.mx` specifier. Keep successful ordinary
 * answers and failed-lookup information untouched. Eligibility uses the
 * resolution call's options, including project-reference redirects.
 */
function resolveWholeFileAliases(
  typescript: typeof ts,
  host: ts.LanguageServiceHost,
  language: Language<string>,
): void {
  let optionsForResolution: ts.CompilerOptions | undefined;
  const resolveImport = createTsconfigPathsResolver(
    typescript,
    () => optionsForResolution,
  );
  const resolve = createResolveModuleName(
    typescript,
    typescript.sys.getFileSize,
    host,
    language.plugins,
    (file) => language.scripts.get(file),
  );
  const eligible = (
    name: string,
    file: string,
    options: ts.CompilerOptions,
  ) => {
    optionsForResolution = options;
    return (
      language.scripts.get(file)?.languageId === MX_LANGUAGE_ID &&
      resolveImport(name, file)?.endsWith(".mx")
    );
  };
  const literals = host.resolveModuleNameLiterals;
  if (literals) {
    host.resolveModuleNameLiterals = (
      imports,
      file,
      redirected,
      options,
      source,
      ...rest
    ) =>
      literals
        .call(host, imports, file, redirected, options, source, ...rest)
        .map((result, index) => {
          const literal = imports[index];
          if (
            result.resolvedModule ||
            !literal ||
            !eligible(literal.text, file, options)
          )
            return result;
          const retried = resolve(
            literal.text,
            file,
            options,
            undefined,
            redirected,
            typescript.getModeForUsageLocation(source, literal, options),
          );
          return retried.resolvedModule ? retried : result;
        });
  }
  const names = host.resolveModuleNames;
  if (names) {
    host.resolveModuleNames = (
      imports,
      file,
      reused,
      redirected,
      options,
      source,
    ) =>
      names
        .call(host, imports, file, reused, redirected, options, source)
        .map((result, index) => {
          const name = imports[index];
          if (result || !name || !eligible(name, file, options)) return result;
          return (
            resolve(
              name,
              file,
              options,
              undefined,
              redirected,
              source?.impliedNodeFormat,
            ).resolvedModule ?? result
          );
        });
  }
}

/** The directory a tsserver project's files are resolved from. */
function projectDirectory(
  typescript: typeof ts,
  info: ts.server.PluginCreateInfo,
): string {
  return info.project.projectKind === typescript.server.ProjectKind.Configured
    ? dirname(info.project.getProjectName())
    : info.project.getCurrentDirectory();
}

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
  mxPlugins: Array<AnyMxLanguagePlugin> = createBuiltinLanguagePlugins(
    typescript,
  ),
) {
  return [
    ...mxPlugins,
    ...(astro &&
    !mxPlugins.some(
      (plugin) =>
        plugin.getLanguageId?.(`component.${AMX_EXTENSION}`) ===
        AMX_LANGUAGE_ID,
    )
      ? [createAmxLanguagePlugin(typescript)]
      : []),
    ...(astro ? [createAstroLanguagePlugin(loadAstro)] : []),
    createCompoundExtensionResolver(typescript),
  ];
}

/**
 * The worker entry sits next to this bundle (`ng-worker.cjs`). Outside the
 * bundle (tests, source checkouts) `__dirname` is the source directory, where
 * the worker is `ng-worker.ts`.
 */
function ngWorkerPath(): string {
  return join(
    __dirname,
    __filename.endsWith(".cjs") ? "ng-worker.cjs" : "ng-worker.ts",
  );
}

/**
 * One Angular diagnostics service per tsserver project: its debounce, its
 * worker per Angular package, and its teardown with the project.
 */
function createEditorNgDiagnostics(
  typescript: typeof ts,
  info: ts.server.PluginCreateInfo,
): NgDiagnosticsService {
  const project = info.project;
  const service = createNgDiagnosticsService({
    workerPath: ngWorkerPath(),
    tsconfigPath:
      project.projectKind === typescript.server.ProjectKind.Configured
        ? project.getProjectName()
        : undefined,
    isOpen: (fileName) =>
      project.getScriptInfo(fileName)?.isScriptOpen() === true,
    watchFile: (fileName, onChange) =>
      info.serverHost.watchFile(fileName, () => onChange()),
    // Results arrive after the request that wanted them: ask tsserver to
    // send a fresh `geterr` round (`Project.refreshDiagnostics`, which
    // emits `projectsUpdatedInBackground`).
    refresh: () => project.refreshDiagnostics?.(),
    log: (message) => project.projectService?.logger?.info(message),
  });
  // Tear the workers down with the project (a worker also ends itself when
  // tsserver's IPC channel closes, so a dying tsserver leaves none behind).
  if (typeof project.close === "function") {
    const close = project.close.bind(project);
    project.close = () => {
      service.dispose();
      close();
    };
  }
  return service;
}

function withSyntaxDiagnostics(
  typescript: typeof ts,
  service: ts.LanguageService,
  getLanguagePlugins: () => Array<AnyMxLanguagePlugin> | undefined,
  getNgDiagnostics: () => NgDiagnosticsService | undefined = () => undefined,
): ts.LanguageService {
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property === "getSemanticDiagnostics") {
        return (fileName: string) => {
          let diagnostics = target.getSemanticDiagnostics(fileName);
          // A host whose own projection makes TypeScript report something
          // spurious gets to drop exactly those, and only those — every other
          // diagnostic on the file passes through untouched.
          for (const plugin of getLanguagePlugins() ?? []) {
            diagnostics =
              plugin.filterSemanticDiagnostics?.(fileName, diagnostics) ??
              diagnostics;
          }
          const ng = isNgMx(fileName) ? getNgDiagnostics() : undefined;
          ng?.request(fileName);
          return ng
            ? [...diagnostics, ...angularDiagnostics(typescript, ng, fileName)]
            : diagnostics;
        };
      }
      if (property === "getCodeFixesAtPosition") {
        return (
          fileName: string,
          start: number,
          end: number,
          errorCodes: readonly number[],
          ...rest: [ts.FormatCodeSettings, ts.UserPreferences]
        ) => {
          // Compiles a file the editor changed since, so the offsets below
          // belong to the text the request is about.
          target.getProgram();
          const diagnostics = (getLanguagePlugins() ?? []).flatMap((plugin) =>
            plugin.getCompileDiagnostics(fileName),
          );
          if (diagnostics.length === 0) {
            return target.getCodeFixesAtPosition(
              fileName,
              start,
              end,
              errorCodes,
              ...rest,
            );
          }
          // TypeScript answers for its own codes only: an MX code is a name,
          // and a code TypeScript never raises has no fix of its own.
          const mxCodes = new Set(diagnostics.map(diagnosticCodeOf));
          const typescriptCodes = errorCodes.filter(
            (code) => Number.isFinite(code) && !mxCodes.has(code),
          );
          return [
            ...(typescriptCodes.length === 0
              ? []
              : target.getCodeFixesAtPosition(
                  fileName,
                  start,
                  end,
                  typescriptCodes,
                  ...rest,
                )),
            ...mxCodeFixes(diagnostics, start, end, errorCodes),
          ];
        };
      }
      if (property !== "getSyntacticDiagnostics") {
        return Reflect.get(target, property, receiver);
      }

      return (fileName: string) => {
        const diagnostics = target.getSyntacticDiagnostics(fileName);
        const compileDiagnostics =
          getLanguagePlugins()?.flatMap((plugin) =>
            plugin.getCompileDiagnostics(fileName),
          ) ?? [];
        // A host-policy problem is about a `package.json`, which tsserver
        // reports no diagnostics for, so it goes on the `.mx` file that was
        // compiled under that policy, at 1:1, naming the `package.json`
        // position (the language server does the same).
        const hostPolicy =
          getLanguagePlugins()?.flatMap(
            (plugin) => plugin.getTargetPolicyDiagnostics?.(fileName) ?? [],
          ) ?? [];
        if (compileDiagnostics.length === 0 && hostPolicy.length === 0) {
          return diagnostics;
        }
        // Keep the historical diagnostic suffix casing: template modules
        // are insensitive only for the ng pipeline; other kinds are exact.
        const source =
          builtinFileKinds.find((kind) =>
            (kind.pipeline === "ng-template"
              ? fileName.toLowerCase()
              : fileName
            ).endsWith(`.${kind.segment}.mx`),
          )?.diagnosticSource ?? "mx";

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
            // The compiler's span when it reported one, else one character;
            // never past the end of the text.
            length: Math.max(
              0,
              Math.min(
                diagnostic.length ?? 1,
                diagnostic.source.length - diagnostic.offset,
              ),
            ),
            category:
              diagnostic.category === "error"
                ? typescript.DiagnosticCategory.Error
                : typescript.DiagnosticCategory.Warning,
            // A dialect's code is its own string, not a TypeScript number, so
            // this cast lies to the type checker. Checked consumers: tsserver's
            // `formatDiag` and `formatDiagnosticToProtocol` copy `code` into the
            // protocol response untouched (it is JSON). Consumers that expect a
            // number (TypeScript's own message table) never see a dialect's.
            code: diagnosticCodeOf(diagnostic) as number,
            source: diagnostic.diagnosticSource ?? source,
            messageText: diagnostic.message,
          })),
          ...hostPolicy.map((diagnostic) => ({
            file: typescript.createSourceFile(
              fileName,
              "",
              typescript.ScriptTarget.Latest,
              false,
              typescript.ScriptKind.TSX,
            ),
            start: 0,
            length: 0,
            category:
              diagnostic.severity === "error"
                ? typescript.DiagnosticCategory.Error
                : typescript.DiagnosticCategory.Warning,
            code: HOST_POLICY_DIAGNOSTIC_CODE,
            source,
            messageText: hostPolicyMessage(diagnostic),
          })),
        ];
      };
    },
  });
}

export type { TargetPolicyDiagnostic } from "@mxlang/core";
export {
  ambientTypeDiagnostics,
  ambientTypeFiles,
  withAmbientTypes,
} from "./ambient-types.ts";
export {
  composeAmxMappings,
  createAmxLanguagePlugin,
} from "./amx-language.ts";
export { createAstroLanguagePlugin } from "./astro-language.ts";
export { applicableFixes, mxCodeFixes } from "./code-fixes.ts";
export {
  createDialectLanguagePlugin,
  DIALECT_LANGUAGE_ID,
  dialectFileExtensions,
} from "./dialect-language.ts";
export {
  HOST_POLICY_DIAGNOSTIC_CODE,
  hostPolicyMessage,
  hostPolicyText,
} from "./host-policy-diagnostics.ts";
export type {
  CompiledNgMx,
  MxCompileDiagnostic,
  MxDiagnosticLanguagePlugin,
  NgMxLanguagePlugin,
  NgMxLanguagePluginOptions,
} from "./language.ts";
export {
  createCompoundExtensionResolver,
  createNgMxLanguagePlugin,
  createRegionLanguagePlugin,
  createRegionLanguagePlugins,
  createSolidMxLanguagePlugin,
  moduleFileExtensions,
} from "./language.ts";
export {
  createAstroTypeSurface,
  createHtmlMappings,
  createMxLanguagePlugin,
  type MxLanguagePluginOptions,
} from "./mx-language.ts";
export {
  type AuthoredSpan,
  approximateSuffix,
  approximateUnmapped,
  approximateUnmappedAll,
  approximateUnmappedDiagnostics,
  approximateUnmappedEmit,
  LANGUAGE_SERVICE_DIAGNOSTIC_METHODS,
  mxBugSuffix,
  PROGRAM_DIAGNOSTIC_METHODS,
  type SpannedVirtualCode,
  unknownPositionSuffix,
} from "./unmapped-diagnostics.ts";
export default pluginFactory;
