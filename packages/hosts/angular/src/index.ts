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
  type AttrTagConfig,
  type CompileResult,
  type CustomTag,
  type MxWarning,
  type TargetLookup,
  TranslateError,
} from "@mxlang/core";
import { angularDeclarations, emitTemplate, type UsedTag } from "./emitter.ts";
import { type AngularMapping, encodeMappings } from "./mapping.ts";
import { angularOwnTargets } from "./own-targets.ts";
import { compileSourceWithHint } from "./structural-attr-hint.ts";

/**
 * Compile-time marker for Angular content projection.
 *
 * An Angular component receives projected nodes through `<ng-content>`, not
 * as a class property value. The config remains visible to core's syntactic
 * caller analysis, while `never` prevents treating the projection as an
 * `@Input()` value in authored TypeScript.
 */
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: public default from decision 106
  C extends AttrTagConfig = {},
> = C extends AttrTagConfig ? never : never;

export {
  type AngularConfig,
  type AngularDiagnosticsMode,
  type OnError,
  readAngularConfig,
} from "./config.ts";
export {
  angularDeclarations,
  TranslateError,
  type UsedTag,
} from "./emitter.ts";
export {
  type AngularMapping,
  anchorFor,
  type LineColumn,
  lineColumnAt,
  lookupMapping,
  type MappingDerive,
  type NodeAnchor,
  offsetAt,
  offsetMappings,
  resolveLineColumn,
  sourceOffsetFor,
} from "./mapping.ts";
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

export {
  createVirtualTagModuleReader,
  type VirtualTagModuleOptions,
} from "./virtual-tags.ts";

export interface CompileOptions {
  /** Custom tags already discovered and loaded by the calling integration. */
  customTags?: Record<string, CustomTag>;
  /** `package.json#mx.angular-template.defaultTag`, already validated (decision 145). */
  defaultTag?: string;
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
  /**
   * The registered targets this compile runs under (decisions 129 and 132).
   * Defaults to this package's own descriptor, which is right for a direct
   * entry; a tool compiling several targets passes the built-in registry's
   * lookup, so a callee importing `AttrTag` from another registered target's
   * package reads the same as it does today.
   */
  targets?: TargetLookup;
}

export interface CompileAngularResult extends CompileResult {
  warnings: MxWarning[];
  /**
   * Every position in the emitted template that came from the `.mx` source,
   * generated offsets relative to `code`.
   *
   * This is what the `.ng.mx` diagnostics path consumes: Angular reports a
   * template diagnostic as an offset into the template string, and
   * `sourceOffsetFor` (`./mapping.ts`) turns it back into a source offset.
   */
  mappings: AngularMapping[];
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
 * The returned `map` is a real source map v3, and `mappings` carries the same
 * information as byte spans: the emitter records a span for every run of
 * source-derived text it writes (tag and attribute names, every expression),
 * so a position inside the emitted template resolves back to the `.mx`.
 * Text runs are deliberately unmapped — see `./mapping.ts` for the
 * whole-to-whole rule that keeps this correct under escaping.
 */
export function compile(
  source: string,
  filename: string,
  options: CompileOptions = {},
): CompileAngularResult {
  const warnings: MxWarning[] = options.warnings ?? [];
  const usedTags: UsedTag[] = [];
  const mappings: AngularMapping[] = [];
  const result = compileSourceWithHint(source, filename, angularDeclarations, {
    customTags: options.customTags,
    defaultTag: options.defaultTag,
    targets: options.targets ?? angularOwnTargets,
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
        false,
        mappings,
      );
    },
  });
  return {
    ...result,
    // A real v3 map, replacing the identity placeholder `compileSource`
    // returns: the emitter recorded a span per source-derived run, and those
    // encode directly into the v3 `mappings` field.
    map: {
      ...result.map,
      mappings: encodeMappings(result.code, source, mappings),
    },
    mappings,
    warnings,
    usedTags,
  };
}

/** `compile()` over a file on disk. */
export function compileFile(
  filename: string,
  options: CompileOptions = {},
): CompileAngularResult {
  return compile(readFileSync(filename, "utf8"), filename, options);
}
