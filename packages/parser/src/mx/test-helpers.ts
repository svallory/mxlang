import { compileSolidMx } from "@mxlang/solid";
import type { MxParseOptions } from "../index.ts";
import { parse } from "../index.ts";
import type { MxRegionCompile } from "./region-compile.ts";

/**
 * Adapts `compileSolidMx`'s own `(source, options)` signature to the
 * `MxRegionCompile` shape the bridge calls — the same adaptation every real
 * `.solid.mx` caller (the Vite plugin, the TypeScript plugin, the language
 * server, the oracle) now has to make explicitly, since the parser no
 * longer performs it as a default.
 */
export const solidRegionCompile: MxRegionCompile = ({ source, ...rest }) =>
  compileSolidMx(source, rest);

/**
 * `parse`, wired up with `compileSolidMx` — the parser no longer defaults to
 * any host, so every in-package test that wants the Solid lowering supplies
 * it explicitly, the same way a real `.solid.mx` caller does.
 */
export function parseSolid(
  source: string,
  filename = "test.solid.mx",
  options: MxParseOptions = {},
) {
  return parse(source, filename, {
    mxRegionCompile: solidRegionCompile,
    ...options,
  });
}
