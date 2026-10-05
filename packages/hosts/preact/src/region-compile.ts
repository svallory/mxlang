/**
 * The `.preact.mx` region entry: `compileJsxRegion` with Preact's dialect,
 * region declarations and segment. A descriptor-free leaf, like `./compile.ts`,
 * so the descriptor can require it without closing an entry-point cycle.
 */
import { preactDialect } from "./dialect.ts";
import { preactRegionDeclarations } from "./emitter.ts";
import {
  type CompileJsxRegionOptions,
  type CompileJsxRegionResult,
  compileJsxRegion,
} from "./region.ts";

/** A `.preact.mx` region's options: the shared JSX region engine's, minus what Preact fixes. */
export type PreactRegionOptions = Omit<
  CompileJsxRegionOptions,
  "dialect" | "declarations" | "segment"
>;

/**
 * Compiles one MX region of a `.preact.mx` module to a Preact JSX expression,
 * under an explicit `targets` lookup.
 */
export function compilePreactRegion(
  source: string,
  options: PreactRegionOptions,
): CompileJsxRegionResult {
  return compileJsxRegion(source, {
    ...options,
    dialect: preactDialect,
    declarations: preactRegionDeclarations,
    segment: "preact",
  });
}
