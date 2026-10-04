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
  hostPolicyText,
  type MxCompileDiagnostic,
  type MxDiagnosticLanguagePlugin,
  type TargetPolicyDiagnostic,
} from "@mxlang/typescript-plugin";
import type { Language, LanguagePlugin } from "@volar/language-core";
import { runTsc } from "@volar/typescript/lib/quickstart/runTsc";
import { createResolveModuleName } from "@volar/typescript/lib/resolveModuleName";
import type ts from "typescript";
import {
  isWatchMode,
  parseBuildMode,
  resolveBuildProjects,
} from "./build-templates.ts";
import {
  checkNgMxGroups,
  checkNgMxProjects,
  type NgDiagnosticsResult,
  type NgProgram,
} from "./ng-diagnostics.ts";
import {
  installWatchTemplatePass,
  rebuildActivity,
  reportMissedRebuildIfMarked,
} from "./watch-templates.ts";

/**
 * The compound extensions `.solid.mx` and `.ng.mx` as `runTsc` wants them: no
 * leading dot, and both halves, because TypeScript's own module resolver appends the terminal
 * segment when probing for declaration files.
 */
const EXTRA_SUPPORTED_EXTENSIONS = [".solid.mx", ".ng.mx", ".mx"];
const ASTRO_SUPPORTED_EXTENSIONS = [
  ...EXTRA_SUPPORTED_EXTENSIONS,
  ".astro",
  ".astro.mx",
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
 * Makes a watch rebuild read an MX file through the same virtual projection the
 * first program used, instead of through the host's own `getSourceFileByPath`.
 *
 * `tsc -w` installs `getSourceFileByPath` on the watch host (`createWatchProgram`,
 * TypeScript 6.0.3 `_tsc.js:129796`) so a changed file is re-read and versioned,
 * and `createProgram` prefers it over `getSourceFile` when it is there
 * (`tryReuseStructureFromOldProgram`, `_tsc.js:123326`) — the single call site
 * that reads a host method that way. Volar's `proxyCreateProgram` patches only
 * `getSourceFile` (`proxyCreateProgram.js:98`), on its own copy of the host, so
 * every *changed* file in a rebuild bypassed the language plugins entirely and
 * was checked as its own MX source: a `.solid.mx` region then parsed as plain
 * TSX and a template with a real `TS2345` reported nothing at all, while every
 * unchanged file kept reporting. That is a silent pass, the one failure mode an
 * agent cannot recover from by reading the output.
 *
 * Deleting the host's own method leaves `createProgram` on the `getSourceFile`
 * path a non-watch run already takes, and loses nothing: the watch host's
 * `getSourceFile` *is* that same versioned `getSourceFileByPath`, called with
 * `toPath(fileName)` (`_tsc.js:129795`), so its source-file cache, its change
 * detection and its failed-lookup watching all still run. Only Volar's
 * projection is added back, which is what the first program of the same watcher
 * already had.
 */
function virtualFilesInWatchRebuilds(host: ts.CompilerHost | undefined): void {
  if (!host?.getSourceFileByPath) return;
  delete host.getSourceFileByPath;
}

/**
 * One run of the real `tsc` entry point (`process.argv` as it stands), with the
 * MX language plugins spliced in. Every plugin it creates is pushed to the given
 * lists. `watchMode` tells the host patches that this run rebuilds on its own,
 * so a rebuild can be noticed (see `rebuildActivity`). Returns tsc's exit code.
 */
function runPatchedTsc(
  astro: boolean,
  diagnosticPlugins: MxDiagnosticLanguagePlugin[],
  ngPlugins: NgProgram[],
  watchMode = false,
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
        ngPlugins.push({
          rootNames: options.rootNames,
          getCompiledNgMx: () => ngMx.getCompiledNgMx(),
        });
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
          setup: (language) => {
            // Runs before Volar copies the host and patches `getSourceFile` on
            // that copy, so every edit below lands on the host it copies from.
            virtualFilesInWatchRebuilds(options.host);
            // Watch only: marks that a rebuild is reading files, so a rebuild
            // whose summary the pass cannot recognize is said out loud.
            if (watchMode) rebuildActivity(options.host);
            fallBackToVolarResolution(
              typescript,
              options.host,
              language,
              astro ? ASTRO_SUPPORTED_EXTENSIONS : EXTRA_SUPPORTED_EXTENSIONS,
            );
          },
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
  const ngPlugins: NgProgram[] = [];
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
  const code = runMxTscBody();
  // A watch rebuild finds its Angular template errors after `runMxTscBody`
  // returned, and sets `process.exitCode` itself (a watcher is killed, not
  // exited). A pass never lowers an exit code to 0; only a failing run sets
  // one, and a clean run leaves whatever the watch pass already found.
  if (code !== 0) process.exitCode = code;
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
  const ngPlugins: NgProgram[] = [];
  const argv = process.argv.slice(2);
  const build = parseBuildMode(argv);

  // `tsc -w` (with or without `-b`) returns from `executeCommandLine` after
  // its first build and rebuilds on its own, so nothing here runs again after
  // the pass made below: every later rebuild needs the template pass of its
  // own, run from inside tsc's rebuild (see `installWatchTemplatePass`).
  const watchMode = isWatchMode(argv, process.cwd());
  const watchPass = watchMode
    ? installWatchTemplatePass({
        argv,
        cwd: process.cwd(),
        build: build !== undefined && !build.clean && !build.dry,
        programs: ngPlugins,
        report: reportNgErrors,
      })
    : undefined;
  const tscExitCode = runPatchedTsc(
    astro,
    diagnosticPlugins,
    ngPlugins,
    watchMode,
  );
  // The first watch build is complete: its summary went out before
  // `executeCommandLine` returned, and a recognized one already ran the pass
  // (`watchPass.ran`). A rebuild mark still set was never cleared by a
  // recognized summary, so decide it now — synchronously, before the
  // fallback template pass below monopolizes this thread and delays the
  // notice past anyone's patience (a loaded CI machine stretches it past the
  // fixed grace this output is read with).
  if (watchMode && watchPass && !watchPass.ran) reportMissedRebuildIfMarked();
  // A watch run re-runs the pass from inside each rebuild; when it printed no
  // summary at all, nothing below ran either and this is its one pass.
  const watchRan = watchPass?.ran === true;

  // Under `-b`, tsc skips an up-to-date project, so no program (and no
  // language plugin) ever sees its `.ng.mx` files. tsc's incremental state
  // knows nothing about templates, so the Angular pass runs over every project
  // of the build graph regardless of that state. A watch run already ran the
  // pass from inside its first build.
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
    build && !build.clean && !build.dry && !watchRan
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
  // Existing host warnings are non-fatal; invalid targets and mismatches
  // fail the run. A file two programs both compiled is reported once.
  const policyDiagnostics = [
    ...new Map(
      diagnosticPlugins
        .flatMap((plugin) => plugin.getTargetPolicyDiagnostics?.() ?? [])
        .map((d) => [`${d.file}\0${d.message}`, d] as const),
    ).values(),
  ];
  reportTargetPolicyDiagnostics(policyDiagnostics);
  const hasPolicyError = policyDiagnostics.some((d) => d.severity === "error");
  const hasCompileError = diagnostics.some(
    (diagnostic) => diagnostic.category === "error",
  );

  // Angular template diagnostics (`mx.angular.diagnostics`, default on). Runs
  // only over `.ng.mx` files that compiled, and never loads compiler-cli when
  // there are none. A template error, or a project whose templates could not
  // be checked at all, fails the run. `--clean` and `--dry` check nothing.
  // A watch run already ran the pass from inside each of its rebuilds; if it
  // never printed one, the pass below is its one.
  const angular = buildGroups
    ? checkNgMxGroups(buildGroups)
    : build || watchRan
      ? { reports: [], errors: [], warnings: [] }
      : checkNgMxProjects(compiledNgMx, argv, process.cwd());
  reportNgDiagnostics(angular);
  const hasAngularError = countNgErrors(angular) > 0;

  return hasCompileError || hasPolicyError || hasAngularError ? 1 : tscExitCode;
}

/**
 * The errors one pass of the Angular template pass found: every template
 * diagnostic that is an error, plus every project whose templates could not be
 * checked at all (reported as `error mxlang:` lines, and a silent pass is the
 * one thing that must not read as clean).
 */
function countNgErrors(result: NgDiagnosticsResult): number {
  return (
    result.errors.length +
    result.reports
      .flatMap((report) => report.diagnostics)
      .filter((diagnostic) => diagnostic.category === "error").length
  );
}

/**
 * Reports one pass's result and returns its error count, for the watch
 * interceptor: tsc's own summary line is written right after, and its count
 * has to carry these errors too. An error found by a rebuild outlives the call
 * that returns here (a watcher is killed, not exited), so it is also the
 * process's exit code — and a later clean pass clears it again, so a watcher
 * whose templates were fixed and that is stopped cleanly exits 0.
 */
let watchFailure = false;

function reportNgErrors(result: NgDiagnosticsResult): number {
  reportNgDiagnostics(result);
  const errors = countNgErrors(result);
  if (errors > 0) {
    process.exitCode = 1;
    watchFailure = true;
  } else if (watchFailure) {
    process.exitCode = 0;
    watchFailure = false;
  }
  return errors;
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
            d.mapped === "exact" || d.mapped === "node"
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
      // The language plugin already drops Babel's 0-based `(line:column)` at
      // its source (`dropBabelPositionSuffix`), so every surface agrees. Kept
      // as a harmless guard for a diagnostic that did not come from a
      // `toSyntaxError` (tsc prints `file(line,column)`, 1-based).
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
 * Prints policy diagnostics in `tsc`'s shape, positioned in the manifest:
 * `package.json(5,13): warning|error TS80003`, with the authored value length.
 */
export function reportTargetPolicyDiagnostics(
  diagnostics: readonly TargetPolicyDiagnostic[],
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
        length: diagnostic.length ?? 0,
        category:
          diagnostic.severity === "error"
            ? typescript.DiagnosticCategory.Error
            : typescript.DiagnosticCategory.Warning,
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
