import { createRequire } from "node:module";
import {
  type CompiledNgMx,
  createAmxLanguagePlugin,
  createAstroLanguagePlugin,
  createCompoundExtensionResolver,
  createMxLanguagePlugin,
  createNgMxLanguagePlugin,
  createSolidMxLanguagePlugin,
  type MxCompileDiagnostic,
  type MxDiagnosticLanguagePlugin,
} from "@mxlang/typescript-plugin";
import type { LanguagePlugin } from "@volar/language-core";
import { runTsc } from "@volar/typescript/lib/quickstart/runTsc";
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
 * Makes Volar's module resolver, not the host's own, answer for every import.
 *
 * Volar's `proxyCreateProgram` keeps the host's `resolveModuleNameLiterals` /
 * `resolveModuleNames` for any import whose specifier does not end in a plugin
 * extension, and only otherwise resolves through its patched resolver (the one
 * that maps `x.d.mx.ts` probes back to `x.mx`). `tsc -p` hands it a plain
 * compiler host with neither method, so every import takes the patched path and
 * `./x` / `./x.ng` find `x.ng.mx`. `tsc -b`'s solution builder installs its own
 * `resolveModuleNameLiterals` on the host, so there an extensionless import
 * takes the stock path and fails with a false TS2307. Removing the builder's
 * methods (both are optional on a `CompilerHost`; its resolution is the same
 * `ts.resolveModuleName`, only with its own cache) makes `-b` resolve exactly
 * as `-p` does. Runs from the language-plugin factory, which Volar calls before
 * it reads the host's resolution methods.
 */
function useVolarModuleResolution(
  host:
    | { resolveModuleNameLiterals?: unknown; resolveModuleNames?: unknown }
    | undefined,
): void {
  if (!host) return;
  host.resolveModuleNameLiterals = undefined;
  host.resolveModuleNames = undefined;
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
        useVolarModuleResolution(options.host);
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
        return plugins;
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

function runMxTscBody(): number {
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
      messageText: diagnostic.message,
    })),
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
