import { readFileSync } from "node:fs";
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
import { reactDeclarations, reactDialect } from "./dialect.ts";

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
    "customTags" | "resolveImport" | "warnings"
  > = {},
): CompilePreactResult {
  return compilePreactMx(source, filename, {
    dialect: reactDialect,
    declarations: reactDeclarations,
    customTags: options.customTags,
    resolveImport: options.resolveImport,
    warnings: options.warnings,
  });
}

/** `compileReactMx()` over a file on disk. */
export function compileReactFile(
  filename: string,
  options: Pick<
    CompilePreactOptions,
    "customTags" | "resolveImport" | "warnings"
  > = {},
): CompileResult {
  return compileReactMx(readFileSync(filename, "utf8"), filename, options);
}
