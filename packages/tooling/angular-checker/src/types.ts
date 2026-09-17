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
   * own defaults (`strict`, `strictTemplates`, bundler resolution).
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
  /** Release the retained program and in-memory sources. */
  dispose(): void;
}
