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
import type { Child } from "hono/jsx";
import { honoDeclarations, honoDialect } from "./dialect.ts";

export { TranslateError } from "@mxlang/preact";
export { honoDeclarations, honoDialect } from "./dialect.ts";
export type { CompileResult, RawSourceMap };

/** Attribute-tag value specialised to Hono's renderable child type. */
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: public default from decision 106
  C extends AttrTagConfig = {},
> = AttrTagOf<C, Child>;

/** Compiles a whole-file MX template to a Hono JSX component module. */
export function compileHonoMx(
  source: string,
  filename: string,
  options: Pick<
    CompilePreactOptions,
    "customTags" | "resolveImport" | "warnings" | "typeCheck"
  > = {},
): CompilePreactResult {
  return compilePreactMx(source, filename, {
    dialect: honoDialect,
    declarations: honoDeclarations,
    customTags: options.customTags,
    resolveImport: options.resolveImport,
    warnings: options.warnings,
    typeCheck: options.typeCheck,
  });
}

/** `compileHonoMx()` over a file on disk. */
export function compileHonoFile(
  filename: string,
  options: Pick<
    CompilePreactOptions,
    "customTags" | "resolveImport" | "warnings" | "typeCheck"
  > = {},
): CompileResult {
  return compileHonoMx(readFileSync(filename, "utf8"), filename, options);
}
