import {
  type AttrTagConfig,
  type AttrTagOf,
  type CompileResult,
  createTargetLookup,
  type RawSourceMap,
  type TargetLookup,
} from "@mxlang/core";
import type { CompilePreactOptions, CompilePreactResult } from "@mxlang/preact";
import type { Child } from "hono/jsx";
import {
  compileHonoFile as compileHonoFileWith,
  compileHonoMx as compileHonoMxWith,
} from "./compile.ts";
import descriptor from "./descriptor.ts";

/**
 * This package's own target table (decisions 129 and 132): the one descriptor
 * it exports, defaulting for a direct entry that names no lookup of its own
 * (design note §5.1, rule (c)). The compile itself runs through
 * `@mxlang/preact`'s shared emitter, but the lookup a caller gets by default
 * is Hono's, so a callee importing `AttrTag` from `@mxlang/hono` is
 * recognised the same as one from `@mxlang/preact`.
 */
const ownTargets: TargetLookup = createTargetLookup([descriptor]);

/**
 * This package's own target lookup, for a direct entry that needs one and has
 * no registry to hand (design note §5.1, rule (c)): the Bun loader scans and
 * compiles under it unless its caller passes `targets`. Exported so those
 * entry points share one instance rather than one per call.
 */
export const honoTargets = ownTargets;

export { TranslateError } from "@mxlang/preact";
export { honoDeclarations, honoDialect } from "./dialect.ts";
export type { CompileResult, RawSourceMap };

/** Attribute-tag value specialised to Hono's renderable child type. */
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: public default from decision 106
  C extends AttrTagConfig = {},
> = AttrTagOf<C, Child>;

/**
 * Compiles a whole-file MX template to a Hono JSX component module.
 *
 * `options.targets` defaults to this package's own lookup; see
 * `@mxlang/preact`'s `CompilePreactOptions.targets`.
 */
export function compileHonoMx(
  source: string,
  filename: string,
  options: Pick<
    CompilePreactOptions,
    "customTags" | "resolveImport" | "warnings" | "targets" | "typeCheck"
  > = {},
): CompilePreactResult {
  return compileHonoMxWith(source, filename, {
    ...options,
    targets: options.targets ?? ownTargets,
  });
}

/** `compileHonoMx()` over a file on disk. */
export function compileHonoFile(
  filename: string,
  options: Pick<
    CompilePreactOptions,
    "customTags" | "resolveImport" | "warnings" | "targets" | "typeCheck"
  > = {},
): CompileResult {
  return compileHonoFileWith(filename, {
    ...options,
    targets: options.targets ?? ownTargets,
  });
}
