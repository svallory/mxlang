import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  type CompiledNgMx,
  createAmxLanguagePlugin,
  createAstroLanguagePlugin,
  createCompoundExtensionResolver,
  createMxLanguagePlugin,
  createNgMxLanguagePlugin,
  createSolidMxLanguagePlugin,
  HOST_POLICY_DIAGNOSTIC_CODE,
  type HostPolicyDiagnostic,
  hostPolicyText,
  type MxCompileDiagnostic,
  type MxDiagnosticLanguagePlugin,
} from "@mxlang/typescript-plugin";
import type { Language, LanguagePlugin } from "@volar/language-core";
import { runTsc } from "@volar/typescript/lib/quickstart/runTsc";
import { createResolveModuleName } from "@volar/typescript/lib/resolveModuleName";
import type ts from "typescript";
import { parseBuildMode, resolveBuildProjects } from "./build-templates.ts";
import {
  checkNgMxGroups,
  checkNgMxProjects,
  type NgDiagnosticsResult,
} from "./ng-diagnostics.ts";

/**
 * The compound extensions `.solid.mx` and `.ng.mx` as `runTsc` wants them: no
 * leading dot, and both halves, because TypeScript's own module resolver appends the terminal
 * segment when probing for declaration files.
 */
const EXTRA_SUPPORTED_EXTENSIONS = [".solid.mx", ".ng.mx", ".mx"];
const ASTRO_SUPPORTED_EXTENSIONS = [
  ...EXTRA_SUPPORTED_EXTENSIONS,
  ".astro",
  ".amx",
];

/**
 * Resolves TypeScript's own `tsc.js`.
 *
 * `runTsc` does not run `tsc` as a subprocess — it reads that file, rewrites
 * it to route program creation through Volar, and evaluates the result. So it
 * needs the path to the real entry point, not the `typescript` module's
 * exports. Resolution is relative to this package so a workspace hoisting the
 * pinned TypeScript anywhere still resolves the same copy the rest of the
 * repo type-checks with.
 */
export function resolveTscPath(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("typescript/lib/tsc.js");
}

/**
 * What the wrapper installed on a host consults: the Volar resolver of the
 * latest program (`setup` re-runs for every project of a `-b`, so it is
 * replaced, not nested) and its cache of resolved imports.
 *
 * The cache holds resolved answers only (a failure is retried, so a module that
 * appears later is found) and re-checks that the cached target still exists. It
 * can therefore only be stale when the old target still exists but a better
 * candidate appears: `x.solid.mx` added beside a cached `x.ng.mx` for `./x`, or
 * a package's `exports` retargeted while the old file stays. It is rebuilt
 * whenever `setup` re-runs (any change of a program's root names or options).
 */
interface VolarFallback {
  resolve: ReturnType<typeof createResolveModuleName>;
  /** Resolved imports only: a failure must be retried once the file appears. */
  resolved: Map<string, ts.ResolvedModuleWithFailedLookupLocations>;
  extensions: readonly string[];
}

const fallbacks = new WeakMap<object, VolarFallback>();

/**
 * Gives an import the host's own resolver left unresolved a second chance
 * through Volar's resolver, the one that maps `x.d.mx.ts` probes back to `x.mx`,
 * and lets that resolver overrule a host answer that is a `.d.ts` shadowing a
 * template of the same stem (what `-p` picks, see `shadowsTemplate`).
 *
 * Volar's `proxyCreateProgram` keeps the host's `resolveModuleNameLiterals` /
 * `resolveModuleNames` for any batch of imports none of which ends in a plugin
 * extension, and only otherwise resolves through its patched resolver. `tsc -p`
 * hands it a plain compiler host with neither method, so every import takes the
 * patched path and `./x` / `./x.ng` find `x.ng.mx`. `tsc -b`'s solution builder
 * installs its own on the host (one shared `compilerHost` for every project and
 * every watch rebuild), so there an extensionless import took the stock path
 * and gave a false TS2307.
 *
 * Wrapping, not replacing, keeps what the host's resolver owns: the builder's
 * cross-project resolution cache and, in `-w` / `-b -w`, the failed-lookup
 * watching that makes a module installed later recover. Where Volar's resolver
 * also fails, the host's own result is returned, so tsc's resolution cache keeps
 * the object (and the failed lookups) it created. Runs from the language
 * plugins' `setup`, which Volar calls before it reads the host's methods; the
 * wrapper goes on a host once, later calls only swap what it consults.
 */
function fallBackToVolarResolution(
  typescript: typeof ts,
  host: ts.CompilerHost | undefined,
  language: Language<string>,
  extensions: readonly string[],
): void {
  if (!host) return;
  const known = fallbacks.has(host);
  fallbacks.set(host, {
    resolve: createResolveModuleName(
      typescript,
      typescript.sys.getFileSize,
      host,
      language.plugins,
      (fileName) => language.scripts.get(fileName),
    ),
    resolved: new Map(),
    extensions,
  });
  if (known) return;

  const state = () => fallbacks.get(host) as VolarFallback;
  /**
   * `x.d.ts` next to `x.ng.mx`: `-p` resolves the template (Volar's
   * `resolveHiddenExtensions`), a host the `.d.ts`. A package's own `.d.ts`
   * (`isExternalLibraryImport`) is deliberately left alone: what a package
   * publishes as its types is the right answer even if a template sits beside
   * it, so there `-b` and `-w` keep the host's `.d.ts` where `-p` alone
   * resolves the template. Pinned by build-resolve-specifiers.test.ts.
   */
  const shadowsTemplate = (module: ts.ResolvedModule | undefined) => {
    const file = module?.resolvedFileName;
    if (!file?.endsWith(".d.ts") || module?.isExternalLibraryImport) {
      return false;
    }
    const stem = file.slice(0, -".d.ts".length);
    return state().extensions.some((extension) =>
      host.fileExists(stem + extension),
    );
  };
  const resolveWithVolar = (
    name: string,
    containingFile: string,
    options: ts.CompilerOptions,
    redirectedReference: ts.ResolvedProjectReference | undefined,
    mode: ts.ResolutionMode,
  ): ts.ResolvedModuleWithFailedLookupLocations => {
    const { resolve, resolved } = state();
    const key = `${dirname(containingFile)}\0${name}\0${mode}\0${redirectedReference?.sourceFile.fileName}`;
    const cached = resolved.get(key);
    if (
      cached?.resolvedModule &&
      host.fileExists(cached.resolvedModule.resolvedFileName)
    ) {
      return cached;
    }
    const result = resolve(
      name,
      containingFile,
      options,
      undefined,
      redirectedReference,
      mode,
    );
    if (result.resolvedModule) resolved.set(key, result);
    return result;
  };
  const needsVolar = (module: ts.ResolvedModule | undefined) =>
    !module || shadowsTemplate(module);

  const literals = host.resolveModuleNameLiterals;
  const names = host.resolveModuleNames;
  if (literals) {
    host.resolveModuleNameLiterals = (
      moduleLiterals,
      containingFile,
      redirectedReference,
      options,
      containingSourceFile,
      ...rest
    ) =>
      literals
        .call(
          host,
          moduleLiterals,
          containingFile,
          redirectedReference,
          options,
          containingSourceFile,
          ...rest,
        )
        .map((result, index) => {
          const literal = moduleLiterals[index];
          if (!literal || !needsVolar(result.resolvedModule)) return result;
          const volar = resolveWithVolar(
            literal.text,
            containingFile,
            options,
            redirectedReference,
            typescript.getModeForUsageLocation(
              containingSourceFile,
              literal,
              options,
            ),
          );
          return volar.resolvedModule ? volar : result;
        });
  }
  if (names) {
    host.resolveModuleNames = (
      moduleNames,
      containingFile,
      reusedNames,
      redirectedReference,
      options,
      containingSourceFile,
    ) =>
      names
        .call(
          host,
          moduleNames,
          containingFile,
          reusedNames,
          redirectedReference,
          options,
          containingSourceFile,
        )
        .map((result, index) =>
          needsVolar(result)
            ? (resolveWithVolar(
                moduleNames[index] as string,
                containingFile,
                options,
                redirectedReference,
                containingSourceFile?.impliedNodeFormat,
              ).resolvedModule ?? result)
            : result,
        );
  }
}

/**
 * One run of the real `tsc` entry point (`process.argv` as it stands), with the
 * MX language plugins spliced in. Every plugin it creates is pushed to the given
 * lists. Returns tsc's exit code.
 */
function runPatchedTsc(
  astro: boolean,
  diagnosticPlugins: MxDiagnosticLanguagePlugin[],
  ngPlugins: { getCompiledNgMx(): CompiledNgMx[] }[],
): number {
  let tscExitCode = 0;
  const exit = process.exit;
  const stopped = Symbol("mx-tsc-exit");
  process.exit = ((code?: number) => {
    tscExitCode = code ?? 0;
    throw stopped;
  }) as typeof process.exit;
  try {
    runTsc(
      resolveTscPath(),
      astro ? ASTRO_SUPPORTED_EXTENSIONS : EXTRA_SUPPORTED_EXTENSIONS,
      (typescript, options) => {
        const solidMx = createSolidMxLanguagePlugin(typescript);
        // `retainCompiled`: Angular template diagnostics run over the very
        // compiles the type-check used, not a second pass of them.
        const ngMx = createNgMxLanguagePlugin(typescript, {
          retainCompiled: true,
        });
        ngPlugins.push(ngMx);
        const mx = createMxLanguagePlugin(typescript);
        diagnosticPlugins.push(solidMx, ngMx, mx);
        const plugins: LanguagePlugin<string>[] = [solidMx, ngMx, mx];
        if (astro) {
          const amx = createAmxLanguagePlugin(typescript);
          diagnosticPlugins.push(amx);
          plugins.push(amx, createAstroLanguagePlugin());
        }
        plugins.push(createCompoundExtensionResolver(typescript));
        return {
          languagePlugins: plugins,
          setup: (language) =>
            fallBackToVolarResolution(
              typescript,
              options.host,
              language,
              astro ? ASTRO_SUPPORTED_EXTENSIONS : EXTRA_SUPPORTED_EXTENSIONS,
            ),
        };
      },
      TYPESCRIPT_OBJECT,
    );
  } catch (cause) {
    if (cause !== stopped) throw cause;
  } finally {
    process.exit = exit;
  }
  return tscExitCode;
}

/**
 * The `.ng.mx` compiles of the program `tsc -p <tsconfig>` would create, built
 * by the very `tsc` entry point, language plugins and resolver `mx-tsc` uses in
 * non-build mode (`--listFilesOnly`: the program is created, nothing is
 * type-checked or emitted). So the set is, by construction, what tsc compiles
 * for that project: `paths`, `moduleResolution`, `references` (a referenced
 * project's sources are substituted by its output `.d.ts`, so its `.ng.mx` is
 * the referenced project's, not this one's) included. tsc's own listing and
 * diagnostics are swallowed.
 */
function compileProjectNgMx(
  astro: boolean,
  tsconfigPath: string,
  diagnosticPlugins: MxDiagnosticLanguagePlugin[],
): CompiledNgMx[] {
  const ngPlugins: { getCompiledNgMx(): CompiledNgMx[] }[] = [];
  const argv = process.argv;
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.argv = [
    argv[0] as string,
    argv[1] as string,
    "-p",
    tsconfigPath,
    "--listFilesOnly",
  ];
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    runPatchedTsc(astro, diagnosticPlugins, ngPlugins);
  } finally {
    process.argv = argv;
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return ngPlugins.flatMap((plugin) => plugin.getCompiledNgMx());
}

/**
 * Per project of the `-b` graph, in graph order, the `.ng.mx` compiles to
 * check. A file belongs to the first project whose program holds it as a source
 * file (overlapping `include`s: first in build order wins), so it is checked
 * once, under that project's tsconfig.
 */
function collectBuildGroups(
  astro: boolean,
  projects: readonly { tsconfigPath: string; hasFiles: boolean }[],
  diagnosticPlugins: MxDiagnosticLanguagePlugin[],
): { tsconfigPath: string; entries: CompiledNgMx[] }[] {
  const claimed = new Set<string>();
  return projects.map(({ tsconfigPath, hasFiles }) => {
    // No root files, no program (a solution root): nothing to compile.
    if (!hasFiles) return { tsconfigPath, entries: [] };
    const entries = compileProjectNgMx(
      astro,
      tsconfigPath,
      diagnosticPlugins,
    ).filter((entry) => !claimed.has(entry.fileName));
    for (const entry of entries) claimed.add(entry.fileName);
    return { tsconfigPath, entries };
  });
}

/**
 * Runs `tsc` with `.solid.mx` files compiled as their lowered TSX.
 *
 * This is the CI half of decision 81: an editor gets `.solid.mx` types from
 * `@mxlang/typescript-plugin` loaded into tsserver, but a `tsc --noEmit` in a
 * build has no tsserver and no plugin host, so the same language plugin is
 * handed to Volar's `runTsc` instead. Both halves share one implementation of
 * the lowering, which is what keeps an editor and CI from disagreeing about
 * whether a file type-checks.
 */
export function runMxTsc(): void {
  process.exitCode = runMxTscBody();
}

/**
 * {@link runMxTsc} for `args` (what follows `mx-tsc` on a command line): runs
 * to completion and returns the exit code instead of setting
 * `process.exitCode`. Output goes to `process.stdout`/`process.stderr` as
 * ever. Additive, for tests that exercise the entry point in-process; the CLI
 * does not use it. `process.argv` is replaced for the call and restored; every
 * path in `args` must be absolute or relative to `process.cwd()` (nothing
 * changes directory). Runs are synchronous and share process-global state
 * (`process.argv`, the stream writes), so they cannot overlap.
 */
export function runMxTscArgs(args: readonly string[]): number {
  const saved = process.argv;
  process.argv = [saved[0] ?? "node", saved[1] ?? "mx-tsc", ...args];
  try {
    return runMxTscBody();
  } finally {
    process.argv = saved;
  }
}

/**
 * Runs `body` with `FORCE_COLOR` hidden from `tsc` when stdout is not a TTY.
 * `tsc` turns its `pretty` output (code frames, declaration sites, ANSI) on
 * for any non-empty `FORCE_COLOR`, which CI sets, so a piped run printed
 * roughly 1.7x the text of the compact `file(L,C): error …` lines. `tsc` only
 * consults the environment when neither `--pretty` nor a tsconfig `pretty`
 * is set, so both of those still win; and on a TTY nothing changes. The
 * variable is restored for the caller afterwards.
 */
function withoutForcedColorOffTty<T>(body: () => T): T {
  const forced = process.env.FORCE_COLOR;
  if (process.stdout.isTTY || forced === undefined) return body();
  delete process.env.FORCE_COLOR;
  try {
    return body();
  } finally {
    process.env.FORCE_COLOR = forced;
  }
}

function runMxTscBody(): number {
  return withoutForcedColorOffTty(runMxTscChecks);
}

function runMxTscChecks(): number {
  const astro = consumeAstroFlag(process.argv);
  const diagnosticPlugins: MxDiagnosticLanguagePlugin[] = [];
  // One language plugin per program: `tsc -b` creates one for each project,
  // and every one of them holds compiles the Angular pass has to see.
  const ngPlugins: { getCompiledNgMx(): CompiledNgMx[] }[] = [];
  const tscExitCode = runPatchedTsc(astro, diagnosticPlugins, ngPlugins);

  // Under `-b`, tsc skips an up-to-date project, so no program (and no
  // language plugin) ever sees its `.ng.mx` files. tsc's incremental state
  // knows nothing about templates, so the Angular pass runs over every project
  // of the build graph regardless of that state.
  const argv = process.argv.slice(2);
  const build = parseBuildMode(argv);
  const compiledNgMx = [
    // A file two projects both compile (via `references`) is checked once.
    ...new Map(
      ngPlugins
        .flatMap((plugin) => plugin.getCompiledNgMx())
        .map((entry) => [entry.fileName, entry] as const),
    ).values(),
  ];
  const buildProjects =
    build && !build.clean ? resolveBuildProjects(argv, process.cwd()) : [];
  const buildGroups =
    build && !build.clean && !build.dry
      ? collectBuildGroups(astro, buildProjects, diagnosticPlugins)
      : undefined;
  if (build?.dry) reportDryRun(buildProjects);

  // The projects' programs were each created again for their `.ng.mx` files,
  // so a diagnostic of a file two runs both compiled would be printed twice.
  const diagnostics = [
    ...new Map(
      diagnosticPlugins
        .flatMap((plugin) => plugin.getCompileDiagnostics())
        .map((d) => [JSON.stringify(d), d] as const),
    ).values(),
  ];
  reportCompileDiagnostics(diagnostics);
  // Host-policy problems (an unknown `mx.host`, a malformed package.json):
  // warnings, so the exit code is what it was before they were printed. A
  // file two programs both compiled is reported once.
  reportHostPolicyDiagnostics([
    ...new Map(
      diagnosticPlugins
        .flatMap((plugin) => plugin.getHostPolicyDiagnostics?.() ?? [])
        .map((d) => [`${d.file}\0${d.message}`, d] as const),
    ).values(),
  ]);
  const hasCompileError = diagnostics.some(
    (diagnostic) => diagnostic.category === "error",
  );

  // Angular template diagnostics (`mx.angular.diagnostics`, default on). Runs
  // only over `.ng.mx` files that compiled, and never loads compiler-cli when
  // there are none. A template error, or a project whose templates could not
  // be checked at all, fails the run. `--clean` and `--dry` check nothing.
  const angular = buildGroups
    ? checkNgMxGroups(buildGroups)
    : build
      ? { reports: [], errors: [], warnings: [] }
      : checkNgMxProjects(compiledNgMx, argv, process.cwd());
  reportNgDiagnostics(angular);
  const hasAngularError =
    angular.errors.length > 0 ||
    angular.reports.some((report) =>
      report.diagnostics.some((d) => d.category === "error"),
    );

  return hasCompileError || hasAngularError ? 1 : tscExitCode;
}

/**
 * `tsc -b --dry` builds nothing, so no template is checked either; say so
 * (and what a real run would check) instead of letting silence read as "ok".
 */
function reportDryRun(projects: readonly { tsconfigPath: string }[]): void {
  for (const project of projects) {
    process.stdout.write(
      `mx-tsc: --dry skips Angular template diagnostics; a build would check the .ng.mx files of '${project.tsconfigPath}'\n`,
    );
  }
}

/**
 * Prints Angular template diagnostics in the same `file(line,col): error TSnnnn`
 * shape as the rest of `mx-tsc`'s output, positioned in the `.ng.mx`, then any
 * condition that kept a project's templates from being checked.
 */
export function reportNgDiagnostics(result: NgDiagnosticsResult): void {
  if (result.reports.length > 0) {
    const require = createRequire(import.meta.url);
    const typescript = require("typescript") as typeof import("typescript");
    const categories = {
      error: typescript.DiagnosticCategory.Error,
      warning: typescript.DiagnosticCategory.Warning,
      suggestion: typescript.DiagnosticCategory.Suggestion,
      message: typescript.DiagnosticCategory.Message,
    } as const;
    const formatted = typescript.formatDiagnostics(
      result.reports.flatMap((report) => {
        const file = typescript.createSourceFile(
          report.fileName,
          report.source,
          typescript.ScriptTarget.Latest,
          false,
          typescript.ScriptKind.TS,
        );
        return report.diagnostics.map((d) => ({
          file,
          start: d.start,
          length: Math.min(d.length, report.source.length - d.start),
          category: categories[d.category],
          code: d.code,
          source: d.source,
          messageText:
            d.mapped === "exact"
              ? d.message
              : `${d.message} (approximate location)`,
        }));
      }),
      {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
      },
    );
    process.stderr.write(formatted);
  }
  for (const warning of result.warnings) {
    process.stderr.write(`warning mxlang: ${warning}\n`);
  }
  for (const error of result.errors) {
    process.stderr.write(`error mxlang: ${error}\n`);
  }
}

/** Prints the compiler failures Volar's empty virtual files cannot expose. */
export function reportCompileDiagnostics(
  diagnostics: readonly MxCompileDiagnostic[],
): void {
  if (diagnostics.length === 0) return;
  const require = createRequire(import.meta.url);
  const typescript = require("typescript") as typeof import("typescript");
  const formatted = typescript.formatDiagnostics(
    diagnostics.map((diagnostic) => ({
      file: typescript.createSourceFile(
        diagnostic.fileName,
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
      source: "mxlang",
      // Babel appends its own 0-based `(line:column)` to a syntax error's
      // message; tsc already prints `file(line,column)` (1-based), so the
      // suffix is a second, different spelling of the same position.
      messageText: diagnostic.message.replace(/\s*\(\d+:\d+\)\s*$/, ""),
    })),
    {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    },
  );
  process.stderr.write(formatted);
}

/**
 * Prints host-policy diagnostics as warnings in `tsc`'s shape, positioned in
 * the `package.json` that caused them: `package.json(5,13): warning TS80003`.
 */
export function reportHostPolicyDiagnostics(
  diagnostics: readonly HostPolicyDiagnostic[],
): void {
  if (diagnostics.length === 0) return;
  const require = createRequire(import.meta.url);
  const typescript = require("typescript") as typeof import("typescript");
  const formatted = typescript.formatDiagnostics(
    diagnostics.map((diagnostic) => {
      let text = "";
      try {
        text = readFileSync(diagnostic.file, "utf8");
      } catch {
        // Unreadable now: print the message without a line/column rather
        // than lose it.
      }
      const file = typescript.createSourceFile(
        diagnostic.file,
        text,
        typescript.ScriptTarget.Latest,
        false,
        typescript.ScriptKind.JSON,
      );
      const line = Math.min(
        Math.max(diagnostic.line - 1, 0),
        file.getLineStarts().length - 1,
      );
      return {
        file: text === "" ? undefined : file,
        start: (file.getLineStarts()[line] ?? 0) + diagnostic.column,
        length: 0,
        category: typescript.DiagnosticCategory.Warning,
        code: HOST_POLICY_DIAGNOSTIC_CODE,
        source: "mxlang",
        messageText: hostPolicyText(diagnostic),
      };
    }),
    {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    },
  );
  process.stderr.write(formatted);
}

/** Removes mx-tsc's own flag before TypeScript parses its command line. */
export function consumeAstroFlag(argv: string[]): boolean {
  let enabled = false;
  for (let index = argv.length - 1; index >= 0; index--) {
    if (argv[index] !== "--astro") continue;
    argv.splice(index, 1);
    enabled = true;
  }
  return enabled;
}

/**
 * The expression `runTsc` splices into the patched `tsc.js` to produce the
 * `typescript` object handed to language plugins.
 *
 * The default is `new Proxy({}, { get: (_, p) => eval(p) })`, evaluated inside
 * `tsc.js`'s own scope, so it resolves only identifiers that happen to be
 * locals of that bundle. `ScriptSnapshot` is not one — it is part of the
 * public `typescript` module but not of the `tsc` entry point — so the
 * language plugin's `ScriptSnapshot.fromString` call dies with
 * `ReferenceError: ScriptSnapshot is not defined` before a single file is
 * checked. Requiring the real module instead gives the same surface the
 * tsserver plugin gets, which is the point: one language plugin, identical
 * behaviour in an editor and in CI.
 */
const TYPESCRIPT_OBJECT = "require('typescript')";
