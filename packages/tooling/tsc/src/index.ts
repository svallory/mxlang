import { createRequire } from "node:module";
import {
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
  const astro = consumeAstroFlag(process.argv);
  const diagnosticPlugins: MxDiagnosticLanguagePlugin[] = [];
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
      (typescript) => {
        const solidMx = createSolidMxLanguagePlugin(typescript);
        const ngMx = createNgMxLanguagePlugin(typescript);
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

  const diagnostics = diagnosticPlugins.flatMap((plugin) =>
    plugin.getCompileDiagnostics(),
  );
  reportCompileDiagnostics(diagnostics);
  const hasCompileError = diagnostics.some(
    (diagnostic) => diagnostic.category === "error",
  );
  process.exitCode = hasCompileError ? 1 : tscExitCode;
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
