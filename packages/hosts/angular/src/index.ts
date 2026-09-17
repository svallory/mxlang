/**
 * `@mxlang/angular` — the Angular host on `@mxlang/core`.
 *
 * Step 1 of the design note (`notes/investigations/angular-host-design.md`):
 * a `.mx` page template compiles to a plain Angular template string, for a
 * watcher to write to `x.component.html` beside a hand-written `x.component.ts`
 * whose `templateUrl` points at it. No MX runtime, no Angular dependency in
 * the user's app — `@angular/compiler` is a devDependency of this package's
 * own tests only.
 */

import { readFileSync } from "node:fs";
import {
  type CompileResult,
  type CustomTag,
  compileSource,
  type MxWarning,
} from "@mxlang/core";
import { angularDeclarations, emitTemplate } from "./emitter.ts";

export { angularDeclarations, TranslateError } from "./emitter.ts";

export interface CompileOptions {
  /** Custom tags already discovered and loaded by the calling integration. */
  customTags?: Record<string, CustomTag>;
  /**
   * Collects positioned warnings — constructs that compile while diverging
   * from an exact Angular equivalent, or dropping something the author wrote.
   *
   * Unset, they print to `console.warn`. See the design note's A2 "Warnings"
   * list.
   */
  warnings?: MxWarning[];
}

export interface CompileAngularResult extends CompileResult {
  warnings: MxWarning[];
}

/**
 * Compiles a `.mx` page template to an Angular template string.
 *
 * The returned `map` is an identity placeholder, matching `@mxlang/html`'s
 * own `compile()`: this emitter builds text directly rather than printing an
 * AST, so there are no node positions to derive real mappings from yet.
 */
export function compile(
  source: string,
  filename: string,
  options: CompileOptions = {},
): CompileAngularResult {
  const warnings: MxWarning[] = options.warnings ?? [];
  const result = compileSource(source, filename, angularDeclarations, {
    customTags: options.customTags,
    warnings,
    emitIr: (ir, ctx) => emitTemplate(ir, ctx),
  });
  return { ...result, warnings };
}

/** `compile()` over a file on disk. */
export function compileFile(
  filename: string,
  options: CompileOptions = {},
): CompileAngularResult {
  return compile(readFileSync(filename, "utf8"), filename, options);
}
