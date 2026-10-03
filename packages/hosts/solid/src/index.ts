import {
  type AttrTagConfig,
  type AttrTagOf,
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

/** Attribute-tag value specialised to Solid's reusable accessor renderable. */
export type AttrTag<
  // biome-ignore lint/complexity/noBannedTypes: public default from decision 106
  C extends AttrTagConfig = {},
> = AttrTagOf<C, () => SolidElement>;

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
