import type {
  CompileResult,
  AttrTag as CoreAttrTag,
  RawSourceMap,
} from "@mxlang/core";
import { createTargetLookup, type TargetLookup } from "@mxlang/core";
import type {
  CompileJsxRegionResult,
  CompilePreactOptions,
  CompilePreactResult,
} from "@mxlang/host-preact";
import type { ReactNode } from "react";
import {
  compileReactFile as compileReactFileWith,
  compileReactMx as compileReactMxWith,
  compileReactRegion as compileReactRegionWith,
  type ReactRegionOptions,
} from "./compile.ts";
import descriptor from "./descriptor.ts";

/**
 * This package's own target table: the one descriptor
 * it exports, defaulting for a direct entry that names no lookup of its own
 * (design note §5.1, rule (c)). The compile itself runs through
 * `@mxlang/host-preact`'s shared emitter, but the lookup a caller gets by default
 * is React's, so a callee importing `AttrTag` from `@mxlang/host-react` is
 * recognised the same as one from `@mxlang/host-preact`.
 */
const ownTargets: TargetLookup = createTargetLookup([descriptor]);

export { TranslateError } from "@mxlang/host-preact";
export type { ReactRegionOptions } from "./compile.ts";
export {
  reactDeclarations,
  reactDialect,
  reactRegionDeclarations,
} from "./dialect.ts";
export type { CompileResult, RawSourceMap };

/**
 * The attribute-tag record a React component receives (spec §8): the
 * first occurrence, carrying every later one, with `map`, `filter`,
 * `length`, `at` and `toArray`. `T` is one occurrence's attributes; its
 * `content` is `ReactNode` unless `T` declares its own, as a tag
 * with params does (`content: (row: Row) => …`).
 */
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: an attribute tag with no attributes
  T extends object = {},
> = CoreAttrTag<"content" extends keyof T ? T : T & { content?: ReactNode }>;

/**
 * Compiles a whole-file MX template to a React component module.
 *
 * `options.targets` defaults to this package's own lookup; see
 * `@mxlang/host-preact`'s `CompilePreactOptions.targets`.
 */
export function compileReactMx(
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
  return compileReactMxWith(source, filename, {
    ...options,
    targets: options.targets ?? ownTargets,
  });
}

/** `compileReactMx()` over a file on disk. */
export function compileReactFile(
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
  return compileReactFileWith(filename, {
    ...options,
    targets: options.targets ?? ownTargets,
  });
}

/**
 * Compiles one MX region of a `.react.mx` module to a React JSX expression.
 *
 * A `.react.mx` file is TypeScript (TSX) with MX regions: hooks and logic
 * live in the surrounding module, and the parser bridge calls this once per
 * region. `options.targets` defaults to this package's own lookup.
 */
export function compileReactRegion(
  source: string,
  options: Omit<ReactRegionOptions, "targets"> & { targets?: TargetLookup },
): CompileJsxRegionResult {
  return compileReactRegionWith(source, {
    ...options,
    targets: options.targets ?? ownTargets,
  });
}
