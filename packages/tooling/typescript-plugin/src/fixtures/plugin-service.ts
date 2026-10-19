import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import pluginFactory from "../index.ts";

const here = dirname(fileURLToPath(import.meta.url));
let nextServiceId = 0;

/**
 * A tsserver plugin-wrapped language service over in-memory files, for tests:
 * the same wiring tsserver gives the plugin (`pluginFactory(...).create(info)`),
 * with `files` as the project's scripts and `rootFiles` as its roots.
 */
export function createPluginService(
  files: Record<string, string>,
  rootFiles: string[],
): ts.LanguageService {
  return createMutablePluginService(files, rootFiles).service;
}

export function createMutablePluginService(
  files: Record<string, string>,
  rootFiles: string[],
  hooks: {
    refreshDiagnostics?: () => void;
    log?: (m: string) => void;
    /** No tsconfig on disk: the real worker then checks under defaults. */
    inferredProject?: boolean;
    /** Per-file `isScriptOpen` (test-only); every file is open by default. */
    isOpen?: (fileName: string) => boolean;
    /** The plugin's `compilerOptions.plugins` entry (`{ astro: true }`). */
    config?: object;
    /** Optional file-local registry: reuse dependency declarations, not projects. */
    documentRegistry?: ts.DocumentRegistry;
  } = {},
): {
  service: ts.LanguageService;
  project: { close(): void };
  setFile(fileName: string, source: string): void;
} {
  const snapshots = new Map(
    Object.entries(files).map(([fileName, source]) => [
      fileName,
      ts.ScriptSnapshot.fromString(source),
    ]),
  );
  const versions = new Map(Object.keys(files).map((fileName) => [fileName, 0]));
  const serviceId = ++nextServiceId;
  const scriptVersion = (fileName: string) => {
    // Installed declarations are immutable for this invocation. Every other
    // file (including Volar's generated files) has a service-specific identity:
    // tests reuse paths with different buffers, hosts and compilation context.
    if (
      !snapshots.has(fileName) &&
      fileName.includes("/node_modules/") &&
      fileName.endsWith(".d.ts")
    ) {
      return "dependency";
    }
    return `${serviceId}:${versions.get(fileName) ?? 0}`;
  };
  const repoRoot = join(here, "..", "..", "..", "..", "..");
  const options: ts.CompilerOptions = {
    strict: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.Preserve,
    allowArbitraryExtensions: true,
    allowImportingTsExtensions: true,
    baseUrl: repoRoot,
    paths: {
      "@mxlang/core": [join(repoRoot, "packages/core/src/index.ts")],
      "@mxlang/target-html": [
        join(repoRoot, "packages/targets/html/src/index.ts"),
      ],
      "@mxlang/host-preact": [
        join(repoRoot, "packages/hosts/preact/src/index.ts"),
      ],
      "@mxlang/host-solid": [
        join(repoRoot, "packages/hosts/solid/src/index.ts"),
      ],
      "@mxlang/host-astro/typecheck": [
        join(repoRoot, "packages/hosts/astro/src/typecheck.ts"),
      ],
      "@mxlang/tsx-bridge": [
        join(repoRoot, "packages/tsx-bridge/src/public.d.ts"),
      ],
    },
    ignoreDeprecations: "6.0",
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => rootFiles,
    getScriptVersion: scriptVersion,
    getScriptKind: (fileName) =>
      fileName.endsWith(".solid.mx") ||
      fileName.endsWith(".react.mx") ||
      fileName.endsWith(".preact.mx") ||
      fileName.endsWith(".hono.mx")
        ? ts.ScriptKind.TSX
        : fileName.endsWith(".tsx")
          ? ts.ScriptKind.TSX
          : ts.ScriptKind.TS,
    getScriptSnapshot(fileName) {
      return (
        snapshots.get(fileName) ??
        (ts.sys.fileExists(fileName)
          ? ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) ?? "")
          : undefined)
      );
    },
    getCurrentDirectory: () => "/project",
    getDefaultLibFileName: (compilerOptions) =>
      ts.getDefaultLibFilePath(compilerOptions),
    fileExists: (fileName) =>
      snapshots.has(fileName) || ts.sys.fileExists(fileName),
    readFile(fileName) {
      const snapshot = snapshots.get(fileName);
      return snapshot
        ? snapshot.getText(0, snapshot.getLength())
        : ts.sys.readFile(fileName);
    },
    readDirectory: ts.sys.readDirectory,
    directoryExists: (directory) =>
      directory === "/project" || ts.sys.directoryExists(directory),
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    resolveModuleNameLiterals(moduleLiterals, containingFile) {
      return moduleLiterals.map((moduleLiteral) => ({
        resolvedModule: ts.resolveModuleName(
          moduleLiteral.text,
          containingFile,
          options,
          host,
        ).resolvedModule,
      }));
    },
  };
  const languageService = ts.createLanguageService(
    host,
    hooks.documentRegistry,
  );
  const project = {
    projectKind: hooks.inferredProject
      ? ts.server.ProjectKind.Inferred
      : ts.server.ProjectKind.Configured,
    getProjectName: () => "/project/tsconfig.json",
    getCurrentDirectory: () => "/project",
    getScriptVersion: scriptVersion,
    getScriptInfo: (fileName: string) => {
      const snapshot = snapshots.get(fileName);
      return snapshot
        ? {
            getSnapshot: () => snapshot,
            isScriptOpen: () => hooks.isOpen?.(fileName) ?? true,
          }
        : undefined;
    },
    readFile: host.readFile,
    fileExists: host.fileExists,
    readDirectory: host.readDirectory,
    useCaseSensitiveFileNames: () => true,
    refreshDiagnostics: () => hooks.refreshDiagnostics?.(),
    close: () => undefined,
    getCanonicalFileName: (fileName: string) => fileName,
    getModuleResolutionCache: () => undefined,
    projectService: {
      host: ts.sys,
      logger: { info: (message: string) => hooks.log?.(message) },
    },
  };
  // SAFETY: this harness supplies the fields the plugin reads; it does not
  // construct tsserver's unrelated project-management and editor machinery.
  const info = {
    project,
    languageService,
    languageServiceHost: host,
    serverHost: ts.sys,
    config: hooks.config ?? {},
    session: {
      change: ({ file }: { file: string }) => {
        versions.set(file, (versions.get(file) ?? 0) + 1);
      },
    },
  } as unknown as ts.server.PluginCreateInfo;

  const service = pluginFactory({ typescript: ts }).create(info);
  return {
    service,
    project,
    setFile(fileName, source) {
      snapshots.set(fileName, ts.ScriptSnapshot.fromString(source));
      versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
    },
  };
}
