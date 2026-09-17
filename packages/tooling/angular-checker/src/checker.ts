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

import { NgtscProgram } from "@angular/compiler-cli";
import ts from "typescript";
import type {
  AngularChecker,
  AngularCheckerOptions,
  CancellationToken,
  Diagnostic,
  DiagnosticCategory,
} from "./types.ts";

/** The TypeScript version templates are checked with. */
export const typescriptVersion: string = ts.version;

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
  d: ts.Diagnostic,
  entry: string,
  fallbackSource: string,
): Diagnostic {
  return {
    file: d.file?.fileName ?? entry,
    start: d.start ?? 0,
    length: d.length ?? 0,
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    category: toCategory(d.category),
    source: d.source ?? fallbackSource,
  };
}

/**
 * Build the compiler options. A project `tsconfig.json`'s own
 * `compilerOptions`/`angularCompilerOptions` are layered on top of the
 * defaults.
 */
function buildOptions(options: AngularCheckerOptions): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    strict: true,
    // `strictTemplates` is an Angular option, not a TypeScript one, so it
    // rides along in the same object (which is how NgtscProgram takes it).
    strictTemplates: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  } as ts.CompilerOptions;

  if (options.tsconfigPath) {
    const read = ts.readConfigFile(options.tsconfigPath, ts.sys.readFile);
    if (!read.error && read.config) {
      const parsed = ts.parseJsonConfigFileContent(
        read.config,
        ts.sys,
        options.projectDir,
      );
      // The project's options win, except `noEmit`: the checker never emits.
      Object.assign(base, parsed.options, { noEmit: true });
      if (read.config.angularCompilerOptions) {
        Object.assign(base, read.config.angularCompilerOptions);
      }
      // `strictTemplates` is FORCED on, not merely defaulted. It is the whole
      // reason this checker exists, and a project that sets it to false would
      // otherwise silently turn template checking off -- the caller would get
      // an empty diagnostic list and read it as "no errors", which is the same
      // silent-success failure the in-memory host guard exists to prevent.
      // A project wanting Angular's own looser behavior should run `ngc`.
      (base as Record<string, unknown>).strictTemplates = true;
    }
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
  files: ReadonlyMap<string, string>,
  projectDir: string,
  options: ts.CompilerOptions,
): ts.CompilerHost {
  const base = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = Object.create(base);

  host.fileExists = (f) => files.has(f) || base.fileExists(f);
  host.readFile = (f) => (files.has(f) ? files.get(f) : base.readFile(f));
  host.getSourceFile = (f, languageVersion, onError, shouldCreate) => {
    const virtual = files.get(f);
    return virtual === undefined
      ? base.getSourceFile(f, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(f, virtual, languageVersion, true);
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
      const compilerOptions = buildOptions(options);
      const host = buildHost(files, options.projectDir, compilerOptions);

      const reusedOldProgram = program !== undefined;
      const next = new NgtscProgram(
        [virtualPath],
        compilerOptions,
        host,
        program,
      );
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
        ...ngRaw.map((d) => toRecord(d, virtualPath, "ngtsc")),
        ...tsRaw.map((d) => toRecord(d, virtualPath, "ts")),
      ];
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
