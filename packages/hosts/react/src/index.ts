import { readFileSync } from "node:fs";
import { createTargetLookup, type TargetLookup } from "@mxlang/core";
import {
  type AttrTagConfig,
  type AttrTagOf,
  type CompilePreactOptions,
  type CompilePreactResult,
  type CompileResult,
  compilePreactMx,
  type RawSourceMap,
} from "@mxlang/preact";
import type { ReactNode } from "react";
import descriptor from "./descriptor.ts";
import { reactDeclarations, reactDialect } from "./dialect.ts";

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

/** Compiles a whole-file MX template to a React component module. */
export function compileReactMx(
  source: string,
  filename: string,
  options: Pick<
    CompilePreactOptions,
    "customTags" | "resolveImport" | "warnings" | "targets"
  > = {},
): CompilePreactResult {
  return compilePreactMx(source, filename, {
    dialect: reactDialect,
    declarations: reactDeclarations,
    customTags: options.customTags,
    resolveImport: options.resolveImport,
    warnings: options.warnings,
    targets: options.targets ?? ownTargets,
  });
}

/** `compileReactMx()` over a file on disk. */
export function compileReactFile(
  filename: string,
  options: Pick<
    CompilePreactOptions,
    "customTags" | "resolveImport" | "warnings" | "targets"
  > = {},
): CompileResult {
  return compileReactMx(readFileSync(filename, "utf8"), filename, options);
}
