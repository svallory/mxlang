import type { File } from "@babel/types";
import type { MxRegionCompile } from "@mxlang/babel";
import type { CustomTag, GeneratedMapping } from "@mxlang/core";
import { parse } from "../index.ts";
import {
  generator,
  hoistedDefineMappings,
  PRINT_OPTIONS,
} from "./hoisted-define-mappings.ts";

/**
 * A source map in the shape `@babel/generator` produces, which is also the
 * shape Vite's `transform` hook accepts. Declared structurally rather than
 * imported from `source-map` so `@mxlang/tsx-bridge` keeps no extra dependency.
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
  dependencies: string[];
  /**
   * The hoisted `<define>`s' mappings (`HoistedDefine.mappings`), rebased onto
   * `code`: `code.slice(generatedStart, generatedEnd)` is each mapping's
   * generated text, and `sourceStart`/`sourceEnd` are file-absolute offsets
   * of the authored text. `map` cannot carry them, since the hoisted
   * declarations are printed without locations. A mapping whose text the
   * printer changed is left out. Absent when there are none.
   */
  mappings?: GeneratedMapping[];
}

export interface PrintOptions {
  /**
   * Custom tags already discovered and loaded by the calling integration.
   * Forwarded through the parser to whichever host lowers each MX region
   * (`mxRegionCompile` below); without it a registered tag is unknown inside
   * the region.
   */
  customTags?: Record<string, CustomTag>;
  /** `package.json#mx.<target>.defaultTag`, forwarded to the host that lowers each region. */
  defaultTag?: string;
  /**
   * Lowers each MX region the bridge finds: the region entry of the host whose
   * file kind this is (its `HostFileKind.compileRegion`). Required whenever the
   * grammar is on (`mx: true`) — the parser has no host of its own, so an
   * absent hook is a compile error at the first region.
   */
  mxRegionCompile?: MxRegionCompile<CustomTag>;
  /**
   * Turns the MX grammar on explicitly, forwarded to `parse` unchanged. Unset,
   * the grammar is on exactly when `mxRegionCompile` is given.
   */
  mx?: boolean;
}

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
 * `@solidjs/compiler`, which parses it but does not strip it, so the types
 * would reach the compiled output.
 *
 * Both entry points share the generator options (`PRINT_OPTIONS`) so the two
 * can never drift: whatever `print` emits for a file, `printAst` emits for
 * that file's AST. The hoisted defines' mappings are measured with the same
 * options.
 */
export function printAst(ast: File, filename: string): PrintResult {
  const result = generator(ast, {
    ...PRINT_OPTIONS,
    sourceMaps: true,
    sourceFileName: filename,
  });

  if (!result.map) {
    throw new Error(`@babel/generator returned no source map for ${filename}`);
  }

  const mappings = hoistedDefineMappings(ast, result.code);
  return {
    code: result.code,
    map: result.map as RawSourceMap,
    dependencies: regionDependencies(ast),
    ...(mappings.length > 0 ? { mappings } : {}),
  };
}

function regionDependencies(ast: File): string[] {
  const dependencies = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const mx = (
      record.extra as { mx?: { dependencies?: string[] } } | undefined
    )?.mx;
    for (const dependency of mx?.dependencies ?? [])
      dependencies.add(dependency);
    for (const key of Object.keys(record)) {
      if (key !== "loc") visit(record[key]);
    }
  };
  visit(ast.program.body);
  return [...dependencies];
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
 * The printing options (`PRINT_OPTIONS`) say why lines are retained.
 */
export function print(
  source: string,
  filename: string,
  options: PrintOptions = {},
): PrintResult {
  return printAst(
    parse(source, filename, {
      mxCustomTags: options.customTags,
      mxDefaultTag: options.defaultTag,
      mxRegionCompile: options.mxRegionCompile,
      mx: options.mx,
    }),
    filename,
  );
}
