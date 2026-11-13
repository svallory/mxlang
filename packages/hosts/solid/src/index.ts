import {
  type AttrTag as CoreAttrTag,
  createTargetLookup,
  registerCalleeInputReader,
  type TargetLookup,
} from "@mxlang/core";
import type { Element as SolidElement } from "solid-js";
import { readSolidCalleeInput } from "./callee-reader.ts";
import {
  type CompileSolidMxOptions,
  type CompileSolidMxResult,
  compileSolidMx as compileRegion,
  compileSolidUnit as compileUnit,
} from "./compile.ts";
import descriptor from "./descriptor.ts";

export type { AttrTagConfig, AttrTagOf } from "@mxlang/core";
export type {
  CompileSolidMxOptions,
  CompileSolidMxResult,
  HoistedDefine,
  HoistedImport,
  RawSourceMap,
} from "./compile.ts";
export {
  createEmitter,
  emitSolid,
  emitSolidWithMappings,
  MX_ESCAPE_BINDING,
  MX_RETURN_PROP,
  SolidEmitter,
  solidDeclarations,
} from "./emitter.ts";
export { appendSolidBuiltinImport } from "./typecheck-module.ts";

/**
 * The attribute-tag record a Solid component receives (spec §8): the
 * first occurrence, carrying every later one, with `map`, `filter`,
 * `length`, `at` and `toArray`. `T` is one occurrence's attributes; its
 * `content` is `() => SolidElement` unless `T` declares its own, as a tag
 * with params does (`content: (row: Row) => …`).
 */
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: an attribute tag with no attributes
  T extends object = {},
> = CoreAttrTag<
  "content" extends keyof T ? T : T & { content?: () => SolidElement }
>;

registerCalleeInputReader(".solid.mx", readSolidCalleeInput);

/** The package's own lookup, shared by direct entries (design note §5.1(c)). */
export const solidTargets: TargetLookup = createTargetLookup([descriptor]);

/** Compiles an MX region; defaults to the package's own lookup. */
export function compileSolidMx(
  source: string,
  options: CompileSolidMxOptions,
): CompileSolidMxResult {
  return compileRegion(source, {
    ...options,
    targets: options.targets ?? solidTargets,
  });
}

/** Compiles a whole MX tag unit; defaults to the package's own lookup. */
export function compileSolidUnit(
  source: string,
  options: CompileSolidMxOptions,
): CompileSolidMxResult {
  return compileUnit(source, {
    ...options,
    targets: options.targets ?? solidTargets,
  });
}
