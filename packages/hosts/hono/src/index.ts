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
import { honoDeclarations, honoTarget } from "./target.ts";

export { TranslateError } from "@mxlang/preact";
export { honoDeclarations, honoTarget } from "./target.ts";
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
  options: Pick<CompilePreactOptions, "customTags" | "resolveImport"> = {},
): CompilePreactResult {
  return compilePreactMx(source, filename, {
    target: honoTarget,
    declarations: honoDeclarations,
    customTags: options.customTags,
    resolveImport: options.resolveImport,
  });
}

/** `compileHonoMx()` over a file on disk. */
export function compileHonoFile(
  filename: string,
  options: Pick<CompilePreactOptions, "customTags" | "resolveImport"> = {},
): CompileResult {
  return compileHonoMx(readFileSync(filename, "utf8"), filename, options);
}
