import {
  type CompileResult,
  type AttrTag as CoreAttrTag,
  createTargetLookup,
  type RawSourceMap,
  type TargetLookup,
} from "@mxlang/core";
import type {
  CompileJsxRegionResult,
  CompilePreactOptions,
  CompilePreactResult,
} from "@mxlang/host-preact";
import type { Child } from "hono/jsx";
import {
  compileHonoFile as compileHonoFileWith,
  compileHonoMx as compileHonoMxWith,
  compileHonoRegion as compileHonoRegionWith,
  type HonoRegionOptions,
} from "./compile.ts";
import descriptor from "./descriptor.ts";

/**
 * This package's own target table: the one descriptor
 * it exports, defaulting for a direct entry that names no lookup of its own
 * (design note §5.1, rule (c)). The compile itself runs through
 * `@mxlang/host-preact`'s shared emitter, but the lookup a caller gets by default
 * is Hono's, so a callee importing `AttrTag` from `@mxlang/host-hono` is
 * recognised the same as one from `@mxlang/host-preact`.
 */
const ownTargets: TargetLookup = createTargetLookup([descriptor]);

/**
 * This package's own target lookup, for a direct entry that needs one and has
 * no registry to hand (design note §5.1, rule (c)): the Bun loader scans and
 * compiles under it unless its caller passes `targets`. Exported so those
 * entry points share one instance rather than one per call.
 */
export const honoTargets = ownTargets;

export { TranslateError } from "@mxlang/host-preact";
export type { HonoRegionOptions } from "./compile.ts";
export {
  honoDeclarations,
  honoDialect,
  honoRegionDeclarations,
} from "./dialect.ts";
export type { CompileResult, RawSourceMap };

/**
 * The attribute-tag record a Hono component receives (spec §8): the
 * first occurrence, carrying every later one, with `map`, `filter`,
 * `length`, `at` and `toArray`. `T` is one occurrence's attributes; its
 * `content` is `Child` unless `T` declares its own, as a tag
 * with params does (`content: (row: Row) => …`).
 */
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: an attribute tag with no attributes
  T extends object = {},
> = CoreAttrTag<"content" extends keyof T ? T : T & { content?: Child }>;

/**
 * Compiles a whole-file MX template to a Hono JSX component module.
 *
 * `options.targets` defaults to this package's own lookup; see
 * `@mxlang/host-preact`'s `CompilePreactOptions.targets`.
 */
export function compileHonoMx(
  source: string,
  filename: string,
  options: Pick<
    CompilePreactOptions,
    | "customTags"
    | "defaultTag"
    | "resolveImport"
    | "warnings"
    | "targets"
    | "typeCheck"
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
    | "customTags"
    | "defaultTag"
    | "resolveImport"
    | "warnings"
    | "targets"
    | "typeCheck"
  > = {},
): CompileResult {
  return compileHonoFileWith(filename, {
    ...options,
    targets: options.targets ?? ownTargets,
  });
}

/**
 * Compiles one MX region of a `.hono.mx` module to a Hono JSX expression.
 *
 * A `.hono.mx` file is TypeScript (TSX) with MX regions: hooks and logic
 * live in the surrounding module, and the parser bridge calls this once per
 * region. `options.targets` defaults to this package's own lookup.
 */
export function compileHonoRegion(
  source: string,
  options: Omit<HonoRegionOptions, "targets"> & { targets?: TargetLookup },
): CompileJsxRegionResult {
  return compileHonoRegionWith(source, {
    ...options,
    targets: options.targets ?? ownTargets,
  });
}
