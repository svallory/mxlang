/**
 * The hono host's compile entry, as a **descriptor-free leaf**.
 *
 * `descriptor.ts` must stay a leaf: it is a bundler entry
 * (`@mxlang/hono/descriptor`) and the registry bundles it into tools, so it
 * may never `require` a module that (transitively) imports it. The compile
 * wrapper therefore lives here, where nothing reaches for `./descriptor.ts`,
 * and both `index.ts` (which composes the package's own lookup) and
 * `descriptor.ts` (which composes a lookup over itself, lazily) call in with
 * an explicit lookup.
 *
 * Revision BUG 1 (rev-245 §1): when the descriptor reached the compile entry
 * through `require("./index.ts")` and the index imported the descriptor back,
 * Bun's multi-entry build could silently drop the index entry with exit 0 on
 * the pinned Bun 1.3.14. The acyclic graph is what makes a bundler keep every
 * entry (`packages/target-registry/src/bundle-smoke.test.ts` pins it).
 */

import { readFileSync } from "node:fs";
import type { TargetLookup } from "@mxlang/core";
import {
  type CompileJsxRegionOptions,
  type CompileJsxRegionResult,
  type CompilePreactOptions,
  type CompilePreactResult,
  type CompileResult,
  compileJsxRegion,
  compilePreactMx,
} from "@mxlang/preact";
import {
  honoDeclarations,
  honoDialect,
  honoRegionDeclarations,
} from "./dialect.ts";

/** This host's compile options: the preact emitter's surface, minus the dialect, which is always hono's here. */
export type HonoCompileOptions = Pick<
  CompilePreactOptions,
  | "customTags"
  | "defaultTag"
  | "resolveImport"
  | "warnings"
  | "targets"
  | "typeCheck"
>;

/** Compiles a whole-file MX template to a Hono JSX component module, under an explicit `targets` lookup. */
export function compileHonoMx(
  source: string,
  filename: string,
  options: HonoCompileOptions & { targets: TargetLookup },
): CompilePreactResult {
  return compilePreactMx(source, filename, {
    dialect: honoDialect,
    declarations: honoDeclarations,
    customTags: options.customTags,
    defaultTag: options.defaultTag,
    resolveImport: options.resolveImport,
    warnings: options.warnings,
    typeCheck: options.typeCheck,
    targets: options.targets,
  });
}

/** `compileHonoMx()` over a file on disk. */
export function compileHonoFile(
  filename: string,
  options: HonoCompileOptions & { targets: TargetLookup },
): CompileResult {
  return compileHonoMx(readFileSync(filename, "utf8"), filename, options);
}

/** A `.hono.mx` region's options: the shared JSX region engine's, minus what Hono fixes. */
export type HonoRegionOptions = Omit<
  CompileJsxRegionOptions,
  "dialect" | "declarations" | "segment"
>;

/**
 * Compiles one MX region of a `.hono.mx` module to a Hono JSX expression,
 * under an explicit `targets` lookup (`@mxlang/preact`'s `compileJsxRegion`
 * with Hono's dialect and region declarations).
 */
export function compileHonoRegion(
  source: string,
  options: HonoRegionOptions,
): CompileJsxRegionResult {
  return compileJsxRegion(source, {
    ...options,
    dialect: honoDialect,
    declarations: honoRegionDeclarations,
    segment: "hono",
  });
}
