/**
 * `@mxlang/html` — MX's vanilla HTML host, on `@mxlang/core`.
 *
 * A `.mx` template becomes a pure `(input) => string` function: no runtime
 * beyond the `escape` helper, no framework. Everything generic —
 * the Marko-node consumer, the `config.translator` seam, the emit model —
 * lives in `@mxlang/core`; this package supplies the *policy* (`translate.ts`)
 * and the integrations (the Bun loader, the `escape` runtime, the taglib).
 *
 * The compile entry itself lives in `./compiler.ts`, a descriptor-free leaf:
 * this module composes the package's own target lookup over `./descriptor.ts`
 * and defaults a direct entry to it, while the descriptor — a bundler entry
 * itself — reaches the compile entry through the leaf instead of through
 * here, keeping the entry graph acyclic (rev-245 BUG 1).
 */

import type {
  AttrTagAttrs,
  AttrTagConfig,
  AttrTagParams,
  CompileResult,
} from "@mxlang/core";
import {
  createTargetLookup,
  type RawSourceMap,
  type TargetLookup,
} from "@mxlang/core";
import {
  type CompileHtmlResult,
  type CompileOptions,
  compileHtml,
  compileHtmlBuild,
  compileHtmlFile,
  createHtmlTranslator,
} from "./compiler.ts";
import descriptor from "./descriptor.ts";

export { escape } from "@mxlang/core";
export { loadMx, type MxOptions, type MxRenderer, mx } from "./helpers.ts";
export { policy, strictPolicy, TranslateError } from "./translate.ts";
export type { CompileHtmlResult, CompileOptions, CompileResult, RawSourceMap };

/** Attribute-tag value received by an `@mxlang/html` component. */
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: matches the public AttrTag default from decision 106
  C extends AttrTagConfig = {},
> = C["as"] extends "renderable"
  ? (...args: AttrTagParams<C>) => string
  : AttrTagAttrs<C> & {
      content?: (...args: AttrTagParams<C>) => string;
    };

/**
 * This package's own target lookup (decisions 129 and 132): the one
 * descriptor it exports, bound by `createTargetLookup`. What a direct entry
 * compiles under when the caller names no lookup of its own (design note
 * §5.1, rule (c)) — the loader, `loadMx`, `example.ts`. A tool that compiles
 * for several targets at once passes the full registry's lookup through
 * `options.targets` instead, since core asks the lookup which packages
 * export `AttrTag` and which file-kind segments exist, and this table holds
 * only this package's answers.
 */
const ownTargets: TargetLookup = createTargetLookup([descriptor]);

/**
 * Exported so the Bun loader, `mx()`, `loadMx()` and `example.ts` share one
 * instance rather than one per call, and so a host composing its own
 * many-target lookup can recognise this package's own table by identity.
 */
export const htmlTargets = ownTargets;

/**
 * The Marko translator object, for `compile(src, file, { translator })`.
 *
 * Exported for a caller that drives `@marko/compiler` itself (the oracle's
 * stock-Marko comparison does). Built by the core, since the seam is the
 * core's.
 */
export const translator = createHtmlTranslator(ownTargets);

/**
 * Compiles a `.mx` template to a runtime-free TypeScript module.
 *
 * `options.targets` defaults to this package's own lookup; see
 * {@link CompileOptions.targets}.
 */
export function compile(
  source: string,
  filename: string,
  options: CompileOptions = {},
): CompileHtmlResult {
  return compileHtml(source, filename, {
    ...options,
    targets: options.targets ?? ownTargets,
  });
}

/** `compile()` over a file on disk. */
export function compileFile(
  filename: string,
  options: CompileOptions = {},
): CompileResult {
  return compileHtmlFile(filename, {
    ...options,
    targets: options.targets ?? ownTargets,
  });
}

/**
 * Compiles a set of templates, returning the emitted module for each.
 *
 * The CLI-free equivalent of a build step: a caller writes the results
 * wherever its own pipeline wants them.
 */
export function build(
  filenames: string[],
  options: CompileOptions = {},
): Map<string, CompileResult> {
  return compileHtmlBuild(filenames, {
    ...options,
    targets: options.targets ?? ownTargets,
  });
}
