import type {
  AttrTagConfig,
  AttrTagOf,
  CompileResult,
  RawSourceMap,
} from "@mxlang/core";
import { createTargetLookup, type TargetLookup } from "@mxlang/core";
import type { CompilePreactOptions, CompilePreactResult } from "@mxlang/preact";
import type { ReactNode } from "react";
import {
  compileReactFile as compileReactFileWith,
  compileReactMx as compileReactMxWith,
} from "./compile.ts";
import descriptor from "./descriptor.ts";

/**
 * This package's own target table (decisions 129 and 132): the one descriptor
 * it exports, defaulting for a direct entry that names no lookup of its own
 * (design note §5.1, rule (c)). The compile itself runs through
 * `@mxlang/preact`'s shared emitter, but the lookup a caller gets by default
 * is React's, so a callee importing `AttrTag` from `@mxlang/react` is
 * recognised the same as one from `@mxlang/preact`.
 */
const ownTargets: TargetLookup = createTargetLookup([descriptor]);

export { TranslateError } from "@mxlang/preact";
export { reactDeclarations, reactDialect } from "./dialect.ts";
export type { CompileResult, RawSourceMap };

/** Attribute-tag value specialised to React's renderable node type. */
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: public default from decision 106
  C extends AttrTagConfig = {},
> = AttrTagOf<C, ReactNode>;

/**
 * Compiles a whole-file MX template to a React component module.
 *
 * `options.targets` defaults to this package's own lookup; see
 * `@mxlang/preact`'s `CompilePreactOptions.targets`.
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
