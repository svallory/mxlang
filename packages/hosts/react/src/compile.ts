/**
 * The react host's compile entry, as a **descriptor-free leaf**.
 *
 * `descriptor.ts` must stay a leaf: it is a bundler entry
 * (`@mxlang/host-react/descriptor`) and the registry bundles it into tools, so it
 * may never `require` a module that (transitively) imports it. The compile
 * wrapper therefore lives here, where nothing reaches for `./descriptor.ts`,
 * and both `index.ts` (which composes the package's own lookup) and
 * `descriptor.ts` (which composes a lookup over itself, lazily) call in with
 * an explicit lookup.
 *
 * Revision BUG 1 (rev-245 §1): when the descriptor reached the compile entry
 * through `require("./index.ts")` and the index imported the descriptor back,
 * Bun's multi-entry build silently dropped the index entry with exit 0 on the
 * pinned Bun 1.3.14. The acyclic graph is what makes a bundler keep every
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
} from "@mxlang/host-preact";
import {
  reactDeclarations,
  reactDialect,
  reactRegionDeclarations,
} from "./dialect.ts";

/** This host's compile options: the preact emitter's surface, minus the dialect, which is always react's here. */
export type ReactCompileOptions = Pick<
  CompilePreactOptions,
  | "customTags"
  | "defaultTag"
  | "resolveImport"
  | "warnings"
  | "targets"
  | "typeCheck"
>;

/** Compiles a whole-file MX template to a React component module, under an explicit `targets` lookup. */
export function compileReactMx(
  source: string,
  filename: string,
  options: ReactCompileOptions & { targets: TargetLookup },
): CompilePreactResult {
  return compilePreactMx(source, filename, {
    dialect: reactDialect,
    declarations: reactDeclarations,
    customTags: options.customTags,
    defaultTag: options.defaultTag,
    resolveImport: options.resolveImport,
    warnings: options.warnings,
    typeCheck: options.typeCheck,
    targets: options.targets,
  });
}

/** `compileReactMx()` over a file on disk. */
export function compileReactFile(
  filename: string,
  options: ReactCompileOptions & { targets: TargetLookup },
): CompileResult {
  return compileReactMx(readFileSync(filename, "utf8"), filename, options);
}

/** A `.react.mx` region's options: the shared JSX region engine's, minus what React fixes. */
export type ReactRegionOptions = Omit<
  CompileJsxRegionOptions,
  "dialect" | "declarations" | "segment"
>;

/**
 * Compiles one MX region of a `.react.mx` module to a React JSX expression,
 * under an explicit `targets` lookup (`@mxlang/host-preact`'s `compileJsxRegion`
 * with React's dialect and region declarations).
 */
export function compileReactRegion(
  source: string,
  options: ReactRegionOptions,
): CompileJsxRegionResult {
  return compileJsxRegion(source, {
    ...options,
    dialect: reactDialect,
    declarations: reactRegionDeclarations,
    segment: "react",
  });
}
