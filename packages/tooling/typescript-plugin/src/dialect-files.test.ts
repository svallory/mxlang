import { join } from "node:path";
import { externalFiles } from "@volar/typescript/lib/quickstart/languageServicePluginCommon";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProbeProjects,
  PROBE_SOURCES,
  probeProject,
} from "../../../../test-fixtures/dialects/probe.ts";
import { createDialectLanguagePlugin } from "./dialect-language.ts";
import pluginFactory from "./index.ts";

/**
 * A dialect's files through the TypeScript plugin: check-only. Their
 * diagnostics are the dialect's own, with `source` the dialect's name and
 * `code` the dialect's code; no other file changes.
 */

function createService(
  dir: string,
  files: Record<string, string>,
): ts.LanguageService {
  // Root: a module importing every file, as a program reaches them.
  const root = join(dir, "consumer.ts");
  const rootSource = Object.keys(files)
    .map(
      (fileName) =>
        `import ${JSON.stringify(`./${fileName.slice(dir.length + 1)}`)};\n`,
    )
    .join("");
  const snapshots = new Map(
    Object.entries({ ...files, [root]: rootSource }).map(
      ([fileName, source]) => [fileName, ts.ScriptSnapshot.fromString(source)],
    ),
  );
  const options: ts.CompilerOptions = {
    strict: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.Preserve,
    allowArbitraryExtensions: true,
    allowImportingTsExtensions: true,
    ignoreDeprecations: "6.0",
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [root],
    getScriptVersion: () => "0",
    getScriptKind: () => ts.ScriptKind.TS,
    getScriptSnapshot: (fileName) =>
      snapshots.get(fileName) ??
      (ts.sys.fileExists(fileName)
        ? ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) ?? "")
        : undefined),
    getCurrentDirectory: () => dir,
    getDefaultLibFileName: (compilerOptions) =>
      ts.getDefaultLibFilePath(compilerOptions),
    fileExists: (fileName) =>
      snapshots.has(fileName) || ts.sys.fileExists(fileName),
    readFile: (fileName) => {
      const snapshot = snapshots.get(fileName);
      return snapshot
        ? snapshot.getText(0, snapshot.getLength())
        : ts.sys.readFile(fileName);
    },
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    resolveModuleNameLiterals: (moduleLiterals, containingFile) =>
      moduleLiterals.map((moduleLiteral) => ({
        resolvedModule: ts.resolveModuleName(
          moduleLiteral.text,
          containingFile,
          options,
          host,
        ).resolvedModule,
      })),
  };
  const project = {
    projectKind: ts.server.ProjectKind.Configured,
    getProjectName: () => join(dir, "tsconfig.json"),
    getCurrentDirectory: () => dir,
    getScriptVersion: () => "0",
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
    projectService: { host: ts.sys, logger: { info: () => undefined } },
  };
  const info = {
    project,
    languageService: ts.createLanguageService(host),
    languageServiceHost: host,
    serverHost: ts.sys,
    config: {},
    session: { change: () => undefined },
  } as unknown as ts.server.PluginCreateInfo;
  return pluginFactory({ typescript: ts }).create(info);
}

/** The structured shape a client of tsserver reads. */
function shape(service: ts.LanguageService, file: string) {
  service.getSemanticDiagnostics(join(file, "..", "consumer.ts"));
  return [
    ...service.getSyntacticDiagnostics(file),
    ...service.getSemanticDiagnostics(file),
  ].map((diagnostic) => ({
    start: diagnostic.start,
    length: diagnostic.length,
    category: ts.DiagnosticCategory[diagnostic.category],
    code: diagnostic.code as unknown,
    source: diagnostic.source,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
}

afterEach(() => cleanupProbeProjects());

describe("dialect files through the TypeScript plugin", () => {
  it("reports lowerSource's diagnostic with the dialect's name as source and its code, at its position", () => {
    const project = probeProject();
    const file = project.path("page.probe");
    const service = createService(project.dir, { [file]: PROBE_SOURCES.bad });
    expect(shape(service, file)).toEqual([
      {
        start: 3,
        length: 1,
        category: "Error",
        code: "PROBE_BAD",
        source: "Probe",
        message: "bad probe",
      },
    ]);
    const [diagnostic] = service.getSyntacticDiagnostics(file);
    expect(diagnostic?.file?.text).toBe(PROBE_SOURCES.bad);
  });

  it("a valid dialect file has no diagnostics of any kind", () => {
    const project = probeProject();
    const file = project.path("page.probe");
    const service = createService(project.dir, { [file]: PROBE_SOURCES.ok });
    expect(shape(service, file)).toEqual([]);
  });

  it("`.probe.mx` is the dialect's file by its longest extension", () => {
    const project = probeProject();
    const file = project.path("page.probe.mx");
    const service = createService(project.dir, { [file]: PROBE_SOURCES.bad });
    expect(shape(service, file)).toEqual([
      {
        start: 3,
        length: 1,
        category: "Error",
        code: "PROBE_BAD",
        source: "Probe",
        message: "bad probe",
      },
    ]);
  });

  it("checks under the dialect's tagRules: `<input>` is unclosed under `none`", () => {
    const project = probeProject();
    const file = project.path("page.probe");
    const service = createService(project.dir, {
      [file]: PROBE_SOURCES.noRules,
    });
    // A diagnostic with no dialect code keeps the plugin's own 80001.
    expect(shape(service, file)).toEqual([
      {
        start: 0,
        length: 1,
        category: "Error",
        code: 80001,
        source: "Probe",
        message: 'Missing ending "input" tag',
      },
    ]);
  });

  it("an .mx file of the same project keeps the MX rules and its own source", () => {
    const project = probeProject();
    const plain = project.path("page.mx");
    const service = createService(project.dir, {
      [plain]: PROBE_SOURCES.noRules,
    });
    // `<input>` is a void element under MX's rules: no syntax error.
    expect(service.getSyntacticDiagnostics(plain)).toEqual([]);
    const broken = project.path("broken.mx");
    const brokenService = createService(project.dir, { [broken]: "<div>\n" });
    expect(
      brokenService.getSyntacticDiagnostics(broken).map((d) => d.source),
    ).toEqual(["mx"]);
  });
});

describe("the dialect language plugin", () => {
  it("claims exactly the extensions it was given, and nothing without any", () => {
    const some = createDialectLanguagePlugin(ts, [".probe", ".probe.mx"]);
    const none = createDialectLanguagePlugin(ts, []);
    const project = probeProject();
    expect(some.getLanguageId(project.path("a.probe"))).toBe("mx-dialect");
    expect(some.getLanguageId(project.path("a.probe.mx"))).toBe("mx-dialect");
    for (const name of ["a.mx", "a.ts", "a.solid.mx", "a.probes", "a.tsx"]) {
      expect(some.getLanguageId(project.path(name)), name).toBeUndefined();
    }
    expect(none.getLanguageId(project.path("a.probe"))).toBeUndefined();
  });

  it("a file of a project that hands the extension to no dialect is not claimed", () => {
    // The plugin was made for one project; a file under another that uses no
    // dialect is no dialect file, whatever its extension.
    const plugin = createDialectLanguagePlugin(ts, [".probe", ".probe.mx"]);
    const plain = probeProject({}, { manifest: null });
    expect(plugin.getLanguageId(plain.path("a.probe"))).toBeUndefined();
    expect(plugin.getLanguageId(plain.path("a.probe.mx"))).toBeUndefined();
  });

  it("tells TypeScript about the extensions, except `.mx`", () => {
    const plugin = createDialectLanguagePlugin(ts, [
      ".probe",
      ".probe.mx",
      ".mx",
    ]);
    expect(
      plugin.typescript?.extraFileExtensions?.map((e) => e.extension),
    ).toEqual(["probe", "probe.mx"]);
  });
});

describe("external files", () => {
  it("tsserver is told about a dialect's files and no other foreign file", () => {
    const project = probeProject();
    const found = [
      project.path("a.probe"),
      project.path("a.probe.mx"),
      project.path("a.mx"),
      project.path("util.ts"),
      project.path("a.probes"),
    ];
    // What Volar found among the project's files by the plugins' extensions.
    const stand = {} as ts.server.Project;
    externalFiles.set(stand, found);
    const plugin = pluginFactory({ typescript: ts });
    expect(plugin.getExternalFiles?.(stand, 0)).toEqual([
      project.path("a.probe"),
      project.path("a.probe.mx"),
      project.path("a.mx"),
    ]);
  });
});
