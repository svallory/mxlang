/**
 * The incremental Angular template checker.
 *
 * Historical note: this package once carried its own `typescript@6` behind a
 * shim (`src/ts6-shim.ts`), because the repo pinned 5.9.3 while
 * `@angular/compiler-cli` required `>=6.0 <6.1` — spike option B, chosen over
 * bumping the whole repo. PR #101 moved the repo to 6.0.3, so the shim's reason
 * to exist is gone and it has been deleted per its own header instructions:
 * this file now imports the workspace TypeScript directly.
 *
 * The **public contract is unchanged**: `check` returns plain records
 * (`types.ts`), never a `ts.Diagnostic`. That was originally forced by the two
 * instances not being mutually assignable, but it is kept on its own merits —
 * it keeps consumers off TypeScript's object graph and lets diagnostics cross
 * a process or cache boundary.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NgtscProgram } from "@angular/compiler-cli";
import type ts from "typescript";
import {
  type CompilerCliModule,
  CompilerCliUnavailableError,
  resolveCompilerCli,
  resolveTypescript,
  type TypescriptModule,
} from "./compiler-cli.ts";
import type {
  AngularChecker,
  AngularCheckerOptions,
  CancellationToken,
  Diagnostic,
  DiagnosticCategory,
} from "./types.ts";

/**
 * A `tsconfigPath` that cannot be read or parsed. Never swallowed: falling
 * back to defaults would check the templates under different options than
 * the code and pass or fail for the wrong reason.
 */
export class TsconfigError extends Error {
  constructor(
    configPath: string,
    diagnostics: readonly (ts.Diagnostic | string)[],
    tsModule: TypescriptModule,
  ) {
    // One line: a reader library may put a stack trace in a message, and
    // only its first line is the reason.
    const reasons = diagnostics.map((d) => {
      const text =
        typeof d === "string"
          ? d
          : tsModule.flattenDiagnosticMessageText(d.messageText, "\n");
      return text.split("\n")[0];
    });
    super(`${configPath}: ${reasons.join("; ")}`);
    this.name = "TsconfigError";
  }
}

/**
 * How many times a program was constructed with a non-undefined `oldProgram`.
 * Test-only introspection: it is what lets the incrementality test assert real
 * reuse rather than merely that two calls happened.
 */
let programReuseCount = 0;

/** Read the reuse counter (test-only). */
export function getProgramReuseCount(): number {
  return programReuseCount;
}

const CATEGORIES: readonly DiagnosticCategory[] = [
  "warning",
  "error",
  "suggestion",
  "message",
];

function toCategory(category: ts.DiagnosticCategory): DiagnosticCategory {
  return CATEGORIES[category] ?? "error";
}

/** Convert one TypeScript diagnostic into a plain record. */
function toRecord(
  tsModule: TypescriptModule,
  d: ts.Diagnostic,
  entry: string,
  fallbackSource: string,
): Diagnostic {
  return {
    file: d.file?.fileName ?? entry,
    start: d.start ?? 0,
    length: d.length ?? 0,
    code: d.code,
    message: tsModule.flattenDiagnosticMessageText(d.messageText, "\n"),
    category: toCategory(d.category),
    source: d.source ?? fallbackSource,
  };
}

/**
 * Build the compiler options. A project `tsconfig.json`'s own
 * `compilerOptions`/`angularCompilerOptions` are layered on top of the
 * defaults.
 */
function buildOptions(
  tsModule: TypescriptModule,
  options: AngularCheckerOptions,
  readConfiguration: CompilerCliModule["readConfiguration"],
): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    strict: true,
    target: tsModule.ScriptTarget.ES2022,
    module: tsModule.ModuleKind.ESNext,
    moduleResolution: tsModule.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  } as ts.CompilerOptions;

  if (options.tsconfigPath) {
    const configPath = resolve(options.tsconfigPath);
    if (!existsSync(configPath)) {
      throw new TsconfigError(
        configPath,
        [`The specified path does not exist: '${configPath}'.`],
        tsModule,
      );
    }
    // compiler-cli's own reader, the one the Angular CLI uses: it resolves
    // `extends` (relative to each tsconfig) and merges `angularCompilerOptions`
    // along the chain, which reading the leaf's JSON would miss.
    const config = readConfiguration(configPath);
    // TS18003 ("no inputs were found") is about the tsconfig's own file list,
    // which the checker never uses: its one root is the virtual module.
    const errors = config.errors.filter((d) => d.code !== 18003);
    if (errors.length > 0)
      throw new TsconfigError(configPath, errors, tsModule);
    // The project's options win, except `noEmit`: the checker never emits.
    // That includes `strictTemplates` (and the other strict* Angular flags):
    // they are NOT forced, so the checker reports what `ng build` reports.
    // Unset, compiler-cli's own default applies (on, in 22.x).
    Object.assign(base, config.options, { noEmit: true });
  }

  if (options.angularCoreTypes) {
    base.paths = {
      ...(base.paths ?? {}),
      "@angular/core": [options.angularCoreTypes],
    };
    base.baseUrl ??= options.projectDir;
  }

  return base;
}

/**
 * Build a compiler host that serves the virtual files from memory.
 *
 * **This is the trap the spike documented.** If `readFile` / `fileExists` /
 * `getSourceFile` do not serve the virtual path, `NgtscProgram` cannot read its
 * root file, analyzes nothing, and returns **zero diagnostics with no error** --
 * indistinguishable from a clean bill of health. `checker.test.ts` pins this
 * with a known-bad template that must produce a diagnostic.
 */
function buildHost(
  tsModule: TypescriptModule,
  files: ReadonlyMap<string, string>,
  projectDir: string,
  options: ts.CompilerOptions,
): ts.CompilerHost {
  const base = tsModule.createCompilerHost(options, true);
  const host: ts.CompilerHost = Object.create(base);

  host.fileExists = (f) => files.has(f) || base.fileExists(f);
  host.readFile = (f) => (files.has(f) ? files.get(f) : base.readFile(f));
  host.getSourceFile = (f, languageVersion, onError, shouldCreate) => {
    const virtual = files.get(f);
    return virtual === undefined
      ? base.getSourceFile(f, languageVersion, onError, shouldCreate)
      : tsModule.createSourceFile(f, virtual, languageVersion, true);
  };
  host.writeFile = () => {};
  host.getCurrentDirectory = () => projectDir;

  return host;
}

/**
 * Create an incremental Angular template checker.
 *
 * The returned checker holds an in-memory map of virtual paths to source text
 * and a retained program. Each `check` reuses the previous program, so an
 * edit-then-check cycle costs materially less than the first call.
 *
 * ```ts
 * const checker = createAngularChecker({ projectDir });
 * const errors = checker.check("/p/x.component.ts", source);
 * checker.dispose();
 * ```
 */
export function createAngularChecker(
  options: AngularCheckerOptions,
): AngularChecker {
  // Resolved from the project, never bundled. Failing here, at creation,
  // means a missing or unsupported compiler-cli can never yield an empty
  // diagnostic list that reads as success.
  const resolution = resolveCompilerCli(options.projectDir);
  if (resolution.status !== "ok") {
    throw new CompilerCliUnavailableError(resolution);
  }
  const tsResolution = resolveTypescript(options.projectDir);
  if (tsResolution.status !== "ok") {
    throw new CompilerCliUnavailableError(tsResolution);
  }
  const tsModule = tsResolution.module;
  const { NgtscProgram: Program } = resolution.module;
  // Fail at creation, not at the first check, if the tsconfig is unusable.
  buildOptions(tsModule, options, resolution.module.readConfiguration);

  const files = new Map<string, string>();
  let program: NgtscProgram | undefined;
  let disposed = false;

  /** How many compilations actually ran -- the incrementality test reads this. */
  let compileCount = 0;

  function assertLive(): void {
    if (disposed) {
      throw new Error("this angular checker has been disposed");
    }
  }

  return {
    check(
      virtualPath: string,
      source: string,
      token?: CancellationToken,
    ): Diagnostic[] {
      assertLive();
      files.set(virtualPath, source);

      // Cancellation is cooperative: NgtscProgram offers no cancellation token
      // of its own, so we poll at the phase boundaries -- before constructing
      // the program and before the (expensive) diagnostics pass. A caller that
      // cancels before the run starts should pay nothing at all.
      if (token?.isCancelled()) return [];

      compileCount += 1;
      const compilerOptions = buildOptions(
        tsModule,
        options,
        resolution.module.readConfiguration,
      );
      const host = buildHost(
        tsModule,
        files,
        options.projectDir,
        compilerOptions,
      );

      const reusedOldProgram = program !== undefined;
      const next = new Program([virtualPath], compilerOptions, host, program);
      if (reusedOldProgram) programReuseCount += 1;
      // Retain the program even on a cancelled run -- it is still a valid base
      // for the next `oldProgram`, and dropping it would make the run after a
      // cancellation pay full cold cost.
      program = next;

      if (token?.isCancelled()) return [];

      // Two diagnostic sources, both needed. `getNgSemanticDiagnostics`
      // reports TEMPLATE errors only; an error in the component's own class
      // body (say `bad: number = "str"`) produces none of them, and reporting
      // a clean result for a file that does not compile is the same
      // silent-success failure the in-memory host guard exists to prevent. So
      // the TypeScript program's own diagnostics for the entry file are
      // collected too.
      const ngRaw = next.getNgSemanticDiagnostics(virtualPath);

      const tsProgram = next.getTsProgram();
      const entrySourceFile = tsProgram.getSourceFile(virtualPath);
      const tsRaw =
        entrySourceFile === undefined
          ? []
          : [
              ...tsProgram.getSyntacticDiagnostics(entrySourceFile),
              ...tsProgram.getSemanticDiagnostics(entrySourceFile),
            ];

      // `source` is what separates the two classes for a consumer. Angular's
      // own diagnostics already carry "ngtsc"; plain TypeScript ones carry
      // nothing, so they are tagged "ts" here rather than left undefined.
      return [
        ...ngRaw.map((d) => toRecord(tsModule, d, virtualPath, "ngtsc")),
        ...tsRaw.map((d) => toRecord(tsModule, d, virtualPath, "ts")),
      ];
    },

    configDiagnostics(): Diagnostic[] {
      assertLive();
      const configPath = options.tsconfigPath
        ? resolve(options.tsconfigPath)
        : "";
      // Built on demand, not retained, when nothing has been checked yet: an
      // empty list must never mean "not computed yet". ngtsc option
      // diagnostics do not depend on any file, so an empty root list is
      // enough (TS-source ones, TS6059 for example, do).
      let target = program;
      if (target === undefined) {
        const compilerOptions = buildOptions(
          tsModule,
          options,
          resolution.module.readConfiguration,
        );
        target = new Program(
          [],
          compilerOptions,
          buildHost(tsModule, files, options.projectDir, compilerOptions),
        );
      }
      const seen = new Set<string>();
      return [
        ...target
          .getNgOptionDiagnostics()
          .map((d) => toRecord(tsModule, d, configPath, "ngtsc")),
        ...target
          .getTsProgram()
          .getOptionsDiagnostics()
          .map((d) => toRecord(tsModule, d, configPath, "ts")),
      ]
        .map((d) => ({ ...d, file: configPath, start: 0, length: 0 }))
        .filter((d) => {
          const key = `${d.source}:${d.code}:${d.message}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    },

    update(virtualPath: string, source: string): void {
      assertLive();
      files.set(virtualPath, source);
    },

    dispose(): void {
      disposed = true;
      files.clear();
      program = undefined;
    },

    // Not part of the public `AngularChecker` interface: test-only
    // introspection so the incrementality test can assert program reuse by
    // counting real compilations instead of timing them.
    ...({ compileCount: () => compileCount } as Record<string, unknown>),
  } as AngularChecker;
}
