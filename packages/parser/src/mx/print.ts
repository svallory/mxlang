import generate from "@babel/generator";
import type { File } from "@babel/types";
import { parse } from "../index.ts";
import type { MxRegionCompile } from "./region-compile.ts";

/**
 * A source map in the shape `@babel/generator` produces, which is also the
 * shape Vite's `transform` hook accepts. Declared structurally rather than
 * imported from `source-map` so `@mxlang/parser` keeps no extra dependency.
 */
export interface RawSourceMap {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
}

export interface PrintResult {
  code: string;
  map: RawSourceMap;
}

export interface PrintOptions {
  /**
   * Custom tags already discovered and loaded by the calling integration.
   * Forwarded through the parser to whichever host lowers each MX region
   * (`mxRegionCompile` below); without it a registered tag is unknown inside
   * the region.
   */
  // biome-ignore lint/suspicious/noExplicitAny: `@mxlang/core`'s CustomTag would be a cycle
  customTags?: Record<string, any>;
  /**
   * Lowers each MX region the bridge finds. Required whenever the grammar is
   * on (`.solid.mx` by name, or `mx: true`) — the parser has no host of its
   * own, so an absent hook is a compile error at the first region. For
   * `.solid.mx`, pass `compileSolidMx` from `@mxlang/solid`.
   */
  mxRegionCompile?: MxRegionCompile;
  /**
   * Turns the MX grammar on explicitly, forwarded to `parse` unchanged. Unset,
   * `parse`'s own `.solid.mx` filename test decides.
   */
  mx?: boolean;
}

/**
 * `@babel/generator` ships as CJS with an interop default; under
 * `esModuleInterop` the namespace can arrive as either the function itself or
 * a `{ default }` wrapper depending on the loader. Normalize once.
 */
const generator = (
  typeof generate === "function"
    ? generate
    : (generate as { default: typeof generate }).default
) as typeof generate;

/**
 * Prints an already-parsed MX AST as JSX source text plus a source map.
 *
 * `print` is the entry point for the ordinary case (source in, text out).
 * This one exists for callers that must run their own pass over the AST
 * first and cannot re-parse afterwards. The oracle is the motivating case:
 * `.solid.mx` fixtures use TypeScript syntax (interfaces, annotations,
 * generics), and the vendored parser accepts that syntax without erasing it,
 * so the AST has to go through `@babel/preset-typescript` before printing.
 * Printing the source directly instead would hand `interface Todo { ... }` to
 * `@solidjs/compiler`, whose JSX frontend has no TypeScript to strip it.
 *
 * Both entry points share the generator options below so the two can never
 * drift: whatever `print` emits for a file, `printAst` emits for that file's
 * AST.
 */
export function printAst(ast: File, filename: string): PrintResult {
  const result = generator(ast, {
    sourceMaps: true,
    sourceFileName: filename,
    retainLines: true,
    jsescOption: { minimal: true },
  });

  if (!result.map) {
    throw new Error(`@babel/generator returned no source map for ${filename}`);
  }

  return { code: result.code, map: result.map as RawSourceMap };
}

/**
 * Parses `source` and prints it back as JSX source text plus a source map.
 *
 * This is MX's product boundary (spec section 3.2): the lowered AST is never
 * handed downstream as an AST, because `@solidjs/compiler` — the default
 * native Solid 2 backend — only accepts source text. Printing real JSX text
 * ahead of Solid's own transform is the one integration surface that reaches
 * both the native and the Babel backend.
 *
 * `retainLines` keeps generated lines aligned with the original so the second
 * source-map hop (MX text -> JSX text -> Solid's output) stays faithful, and
 * `jsescOption.minimal` stops non-ASCII text from being escaped into `\uXXXX`
 * noise that would not match the hand-written twins.
 */
export function print(
  source: string,
  filename: string,
  options: PrintOptions = {},
): PrintResult {
  return printAst(
    parse(source, filename, {
      mxCustomTags: options.customTags,
      mxRegionCompile: options.mxRegionCompile,
      mx: options.mx,
    }),
    filename,
  );
}
