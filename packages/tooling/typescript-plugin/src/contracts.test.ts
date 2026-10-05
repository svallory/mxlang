import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearScanCache } from "@mxlang/core";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import pluginFactory from "./index.ts";

/**
 * `mx.contracts` (decision 142) through the TypeScript plugin: a contract-only
 * tag declared by a package-level contracts module surfaces the compiler's
 * positioned error as a TS80001 diagnostic on the `.mx` file. The edit half
 * documents the long-lived-process limitation (TODO `sync-esm-reload-node`):
 * tsserver keeps running, Node's ESM loader cache survives `require.cache`
 * eviction, so the edited module's exports stay stale until restart — the
 * diagnostic is pinned unchanged here, and `mx-tsc`'s fresh-process run in
 * `tsc/src/contracts.test.ts` proves the edit itself is correct.
 *
 * The contract rides `<style>`, a name the html host claims: a contract-only
 * tag is only valid where the active target delegates the name.
 *
 * The service harness below mirrors `index.test.ts`'s
 * `createMutablePluginService`; it is copied rather than shared because that
 * helper is local to the file it grew up in.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

function createService(
  files: Record<string, string>,
  rootFiles: string[],
): {
  service: ts.LanguageService;
  setFile(fileName: string, source: string): void;
} {
  const snapshots = new Map(
    Object.entries(files).map(([fileName, source]) => [
      fileName,
      ts.ScriptSnapshot.fromString(source),
    ]),
  );
  const versions = new Map(Object.keys(files).map((fileName) => [fileName, 0]));
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
      "@mxlang/html": [join(repoRoot, "packages/targets/html/src/index.ts")],
      "@mxlang/tsx-bridge": [join(repoRoot, "packages/tsx-bridge/src/public.d.ts")],
    },
    ignoreDeprecations: "6.0",
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => rootFiles,
    getScriptVersion: (fileName) => String(versions.get(fileName) ?? 0),
    getScriptKind: (fileName) =>
      fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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
  const languageService = ts.createLanguageService(host);
  const project = {
    projectKind: ts.server.ProjectKind.Configured,
    getProjectName: () => "/project/tsconfig.json",
    getCurrentDirectory: () => "/project",
    getScriptVersion: (fileName: string) => String(versions.get(fileName) ?? 0),
    getScriptInfo: (fileName: string) => {
      const snapshot = snapshots.get(fileName);
      return snapshot
        ? { getSnapshot: () => snapshot, isScriptOpen: () => true }
        : undefined;
    },
    readFile: host.readFile,
    fileExists: host.fileExists,
    readDirectory: host.readDirectory,
    useCaseSensitiveFileNames: () => true,
    refreshDiagnostics: () => undefined,
    close: () => undefined,
    getCanonicalFileName: (fileName: string) => fileName,
    getModuleResolutionCache: () => undefined,
    projectService: {
      host: ts.sys,
      logger: { info: () => undefined },
    },
  };
  const info = {
    project,
    languageService,
    languageServiceHost: host,
    serverHost: ts.sys,
    config: {},
    session: {
      change: ({ file }: { file: string }) => {
        versions.set(file, (versions.get(file) ?? 0) + 1);
      },
    },
  } as unknown as ts.server.PluginCreateInfo;

  const service = pluginFactory({ typescript: ts }).create(info);
  return {
    service,
    setFile(fileName, source) {
      snapshots.set(fileName, ts.ScriptSnapshot.fromString(source));
      versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
    },
  };
}

const MODULE_NONCE =
  "export default { style: { attributes: { nonce: { type: 'string', required: true } } } };\n";
const MODULE_MEDIA =
  "export default { style: { attributes: { media: { type: 'string', required: true } } } };\n";
const PAGE_SOURCE = "<style>\n  .x { color: red }\n</style>\n";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  clearScanCache();
});

function contractProject(moduleSource: string): {
  dir: string;
  page: string;
  consumer: string;
} {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mx-plugin-contracts-")));
  dirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "plugin-contracts-fixture",
      mx: { host: "html", contracts: "./contracts.ts" },
    }),
  );
  writeFileSync(join(dir, "contracts.ts"), moduleSource);
  const page = join(dir, "page.mx");
  writeFileSync(page, PAGE_SOURCE);
  const consumer = join(dir, "consumer.ts");
  writeFileSync(consumer, 'import "./page.mx";\n');
  return { dir, page, consumer };
}

function mx80001(service: ts.LanguageService, page: string): string[] {
  return service
    .getSyntacticDiagnostics(page)
    .filter((diagnostic) => diagnostic.code === 80001)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
}

describe("mx.contracts through the TypeScript plugin", () => {
  it("reports a positioned module contract error and documents long-lived Node ESM reload", () => {
    const { dir, page, consumer } = contractProject(MODULE_NONCE);
    const { service, setFile } = createService(
      {
        [page]: PAGE_SOURCE,
        [consumer]: 'import "./page.mx";\n',
      },
      [consumer],
    );

    service.getSemanticDiagnostics(consumer);
    const messages = mx80001(service, page);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(
      "`<style>`: missing required attribute `nonce`",
    );
    // The diagnostic sits at the authored call: line 1, column 0, whose
    // offset is the start of the file.
    const [diagnostic] = service
      .getSyntacticDiagnostics(page)
      .filter((d: ts.Diagnostic) => d.code === 80001);
    expect(diagnostic?.start).toBe(0);

    // Edit the module and force the plugin to re-create the virtual code.
    // The rescan happens (mtime change), but the process is long-lived and
    // Node's ESM loader cache outlives `require.cache` eviction, so the
    // re-required module serves its stale exports: the contract still
    // requires `nonce`. This pins TODO `sync-esm-reload-node`; `mx-tsc`'s
    // fresh-process run picks the same edit up.
    writeFileSync(join(dir, "contracts.ts"), MODULE_MEDIA);
    setFile(page, PAGE_SOURCE);
    service.getSemanticDiagnostics(consumer);

    expect(mx80001(service, page)).toEqual(messages);

    // The cached old contract still accepts nonce, proving this is a real
    // contract diagnostic rather than an unrelated virtual-module error.
    setFile(page, PAGE_SOURCE.replace("<style>", '<style nonce="abc">'));
    service.getSemanticDiagnostics(consumer);
    expect(mx80001(service, page)).toEqual([]);
    service.dispose();
  });
});
