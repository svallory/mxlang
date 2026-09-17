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
  TranslateError,
} from "@mxlang/core";
import { angularDeclarations, emitTemplate, type UsedTag } from "./emitter.ts";

export {
  angularDeclarations,
  TranslateError,
  type UsedTag,
} from "./emitter.ts";
export {
  type CompileNgMxOptions,
  type CompileNgMxResult,
  compileNgMx,
  escapeTemplateLiteral,
  NG_MX_POSITION_MESSAGE,
  type NgMxRegion,
  ngMxPositionCheck,
} from "./ng-mx.ts";
export {
  type CompileTagModuleOptions,
  type CompileTagModuleResult,
  compileTagModule,
  compileTagModuleFile,
} from "./tag-module.ts";

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
  /**
   * The element-name prefix for an MX tag, `mx.angular.tagSelectorPrefix`.
   * Defaults to `mx-`; a tag file's own `export const selector` still wins.
   */
  tagSelectorPrefix?: string;
}

export interface CompileAngularResult extends CompileResult {
  warnings: MxWarning[];
  /**
   * Every MX tag this template called, in source order, as the caller's own
   * TypeScript must name it: the class the tag's emitted module exports and
   * that module's relative import path.
   *
   * Not the binding the IR carried — a tag discovered under `tags/` reaches
   * the emitter under a gensym'd binding (`$mx_Icon1`) that appears nowhere
   * the author wrote or can see.
   */
  usedTags: UsedTag[];
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
  const usedTags: UsedTag[] = [];
  const result = compileSource(source, filename, angularDeclarations, {
    customTags: options.customTags,
    warnings,
    emitIr: (ir, ctx) => {
      // Same guard as `compileTagModule` (tag-module.ts), for a *page*: a
      // page has no caller to bind `/var`, and Angular template syntax has
      // no binding position to receive a returned value either. Left
      // unchecked, `<return value=x/>` is accepted and emits nothing (spec
      // §13.3 bug 8) — the S8 silent-drop class this checks against.
      if (ir.returnValue) {
        const at = ir.returnValue.node?.loc?.start;
        throw new TranslateError(
          "`<return>` is not supported on Angular: a page has no caller to hand a value to, and Angular template syntax has no binding position to receive one. Declare the value as a `@Input()`/class member instead, or expose it as a `static`/`export`.",
          at?.line ?? 0,
          at?.column ?? 0,
          filename,
        );
      }
      return emitTemplate(
        ir,
        ctx,
        filename,
        usedTags,
        options.tagSelectorPrefix,
      );
    },
  });
  return { ...result, warnings, usedTags };
}

/** `compile()` over a file on disk. */
export function compileFile(
  filename: string,
  options: CompileOptions = {},
): CompileAngularResult {
  return compile(readFileSync(filename, "utf8"), filename, options);
}
