/**
 * The public boundary of `@mxlang/angular-checker`.
 *
 * Nothing in this file references TypeScript's own types. This began as a
 * hard requirement -- the package carried its own `typescript@6` whose types
 * were not assignable to the repo's then-pinned 5.9.3 -- and is kept now that
 * both are 6.0.3, because a plain record keeps consumers off TypeScript's
 * object graph and can cross a process or cache boundary.
 */

/** Severity of a diagnostic, flattened from TypeScript's numeric enum. */
export type DiagnosticCategory = "error" | "warning" | "suggestion" | "message";

/**
 * One template diagnostic, positioned in the source text that was handed to
 * {@link AngularChecker.check}.
 */
export interface Diagnostic {
  /** The virtual path the diagnostic belongs to, as passed to `check`. */
  file: string;
  /**
   * Offset into the source text passed to `check`, in UTF-16 code units.
   *
   * Templates are emitted as backtick literals (ruling c), so an offset that
   * lands inside a template literal is 1:1 with the template text: subtract
   * the offset of the character after the opening backtick and the result
   * indexes the raw template directly, with no escape-aware inverse.
   */
  start: number;
  /** Length of the flagged span, in UTF-16 code units. */
  length: number;
  /**
   * TypeScript/Angular diagnostic code. Template *type* errors carry ordinary
   * TS codes (2339, 2551, ...); template *parse* errors carry negative codes
   * (e.g. -995002). Consumers must not filter on a code range -- use
   * {@link Diagnostic.source} to separate Angular diagnostics from plain TS.
   */
  code: number;
  /** Flattened message text, newline-joined for chained messages. */
  message: string;
  category: DiagnosticCategory;
  /**
   * Which checker produced this: `"ngtsc"` for an Angular template diagnostic,
   * `"ts"` for an ordinary TypeScript one from the component's own module.
   *
   * Both classes are reported, because `getNgSemanticDiagnostics` covers
   * templates *only* -- a plain error in the class body (`bad: number = "str"`)
   * produces no Angular diagnostic at all, and returning a clean list for a
   * file that does not compile would read as success.
   *
   * Filter on this, never on {@link Diagnostic.code}: template type errors
   * carry ordinary TS codes.
   */
  source: string;
}

/** Options for {@link createAngularChecker}. */
export interface AngularCheckerOptions {
  /**
   * Directory the virtual files are resolved relative to. Module specifiers in
   * the checked source (notably `@angular/core`) resolve from here, so this
   * must be a directory from which the project's `@angular/core` is reachable.
   */
  projectDir: string;
  /**
   * Path to the project's `tsconfig.json`. When omitted, the checker uses its
   * own defaults (`strict`, bundler resolution; `strictTemplates` is left to
   * compiler-cli's default, on). Its `angularCompilerOptions`, `strictTemplates`
   * included, are honoured, never forced.
   */
  tsconfigPath?: string;
  /**
   * Explicit path to `@angular/core`'s type entry point. When omitted, normal
   * node resolution from {@link AngularCheckerOptions.projectDir} is used.
   */
  angularCoreTypes?: string;
}

/**
 * A cancellation token. `check` polls it between compiler phases; when it reads
 * cancelled, `check` abandons the run and returns an empty list rather than
 * throwing.
 */
export interface CancellationToken {
  isCancelled(): boolean;
}

/** An incremental Angular template checker over in-memory sources. */
export interface AngularChecker {
  /**
   * Type-check `source` as the contents of `virtualPath` and return the
   * template diagnostics for it.
   *
   * Successive calls reuse the previous program, so an edit-then-check cycle
   * is materially cheaper than the first call.
   *
   * Passing a `token` that reads cancelled abandons the run and returns `[]`.
   *
   * Returns this file's diagnostics only. **Compiler option errors** (a config
   * problem `ng build` fails on, such as `extendedDiagnostics` with
   * `strictTemplates: false`) are not here: read them with
   * {@link AngularChecker.configDiagnostics}, once per project, or a broken
   * configuration reads as a clean file.
   */
  check(
    virtualPath: string,
    source: string,
    token?: CancellationToken,
  ): Diagnostic[];
  /**
   * Register new contents for `virtualPath` without type-checking it, so a
   * later `check` of a *different* file sees the update.
   */
  update(virtualPath: string, source: string): void;
  /**
   * Compiler *option* errors (Angular's `getNgOptionDiagnostics` and
   * TypeScript's `getOptionsDiagnostics`), for example `extendedDiagnostics`
   * combined with `strictTemplates: false`, which `ng build` rejects. They
   * belong to the configuration, not to any file, so `check` never returns
   * them: each record has `file` set to the tsconfig (empty when none was
   * given), `start` and `length` 0, and each distinct problem appears once.
   * Call it once per project, not per file. It works before any `check`
   * (a program is built on demand), so `[]` always means "no option errors".
   * `source: "ts"` records duplicate what `tsc` itself reports for the same
   * tsconfig; a caller that also runs the TypeScript pass should keep only
   * the `"ngtsc"` ones.
   */
  configDiagnostics(): Diagnostic[];
  /** Release the retained program and in-memory sources. */
  dispose(): void;
}
