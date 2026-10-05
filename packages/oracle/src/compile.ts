import { readFileSync } from "node:fs";
import {
  type PluginObj,
  type TransformOptions,
  transformSync,
} from "@babel/core";
import typescriptPreset from "@babel/preset-typescript";
import type { File } from "@babel/types";
import { printAst } from "@mxlang/tsx-bridge";
import solidBabelPlugin from "@solidjs/babel-plugin";
import { transform as nativeTransform } from "@solidjs/compiler";

export class MxParserUnavailable extends Error {
  constructor(filename: string) {
    super(`opts.mxParser was not provided; cannot compile ${filename}`);
    this.name = "MxParserUnavailable";
  }
}

export type SolidGenerate = "dom" | "ssr";

/**
 * Which Solid 2 compiler turns JSX into `dom-expressions` output.
 *
 * `babel` is `@solidjs/babel-plugin`, the successor to `babel-preset-solid`
 * and an ordinary Babel plugin over a Babel JSX AST. `native` is
 * `@solidjs/compiler`, Solid's Oxc compiler and the default backend of
 * `@solidjs/vite-plugin`; its only entry point is `transform(code, options)`
 * over **source text**, so MX reaches it by printing its lowered AST back to
 * JSX text first (spec section 3.2). Both are checked because MX must produce
 * output that survives either one.
 */
export type SolidBackend = "babel" | "native";

export interface SolidVariant {
  generate: SolidGenerate;
  hydratable: boolean;
}

export const VARIANTS: SolidVariant[] = [
  { generate: "dom", hydratable: false },
  { generate: "ssr", hydratable: true },
];

export const BACKENDS: SolidBackend[] = ["babel", "native"];

export type MxParser = (source: string, filename: string) => File;

export interface CompileOptions {
  mxParser?: MxParser;
}

/** `dom` / `ssr-hydratable`, the key used in golden filenames and the report table. */
export function variantKey(variant: SolidVariant): string {
  return `${variant.generate}${variant.hydratable ? "-hydratable" : ""}`;
}

function isMxPath(filename: string): boolean {
  return filename.endsWith(".solid.mx");
}

/**
 * Strips TypeScript syntax and, for `.solid.mx`, parses with the MX parser.
 * Returns JSX source text: what both Solid 2 backends consume as input.
 *
 * Both `.tsx` and `.solid.mx` sources may use TypeScript syntax (interfaces,
 * type annotations, generics); the vendored MX parser accepts that syntax but
 * does not strip it, so the TypeScript preset's erasure pass has to run on the
 * MX AST too, not just on `.tsx` input — otherwise type nodes leak into the
 * compiled output and break byte parity against a twin that went through the
 * ordinary TS pipeline.
 *
 * MX input is printed with `@mxlang/tsx-bridge`'s `printAst` rather than left to
 * Babel's own output stage, because that printer (and its
 * `retainLines`/`jsescOption` settings) is MX's real product boundary: the
 * text the native compiler will actually receive in the Vite plugin.
 * Compiling anything else here would test a pipeline no consumer runs.
 *
 * `printAst` rather than `print` because `print` parses its own source, which
 * would skip the TypeScript erasure above — the fixtures use interfaces and
 * annotations, and the native compiler's JSX frontend parses TypeScript but
 * does not strip it, so the types would survive into the compared output.
 */
function toJsxSource(
  source: string,
  filename: string,
  opts: CompileOptions,
): string {
  const isMx = isMxPath(filename);

  const plugins: TransformOptions["plugins"] = [];
  if (isMx) {
    if (!opts.mxParser) {
      throw new MxParserUnavailable(filename);
    }
    const mxParser = opts.mxParser;
    // @babel/core's PluginObj type doesn't model parserOverride, though it's
    // a real hook (same one @marko/compiler uses). Cast at the boundary.
    const overridePlugin = {
      name: "mx-oracle-parser-override",
      parserOverride(code: string) {
        return mxParser(code, filename);
      },
    } as unknown as PluginObj;
    plugins.push(overridePlugin);
  }

  const result = transformSync(source, {
    filename,
    presets: [[typescriptPreset, { isTSX: true, allExtensions: true }]],
    plugins,
    babelrc: false,
    configFile: false,
    // Keep the AST so MX output goes through `print()`, not Babel's printer.
    ast: isMx,
    code: !isMx,
  });

  if (isMx) {
    if (!result?.ast) {
      throw new Error(`Babel produced no AST for ${filename}`);
    }
    return printAst(result.ast as File, filename).code;
  }

  if (!result?.code) {
    throw new Error(`Babel produced no JSX source for ${filename}`);
  }

  return result.code;
}

/**
 * Compiles a single source file through one Solid 2 backend for the given
 * variant.
 *
 * Both backends receive the same JSX source text, so a diff between them is a
 * codegen difference in Solid, never a difference in what MX handed over. The
 * `native` path prints that text through `printAst` for `.solid.mx` — the
 * native compiler has no AST-injection API — while the `babel` path re-parses
 * it with `@solidjs/babel-plugin`'s own JSX syntax plugin.
 *
 * Option names carry over from `babel-preset-solid` unchanged (`generate`,
 * `hydratable`); both 2.0 packages document the same spelling.
 */
export function compile(
  source: string,
  filename: string,
  variant: SolidVariant,
  backend: SolidBackend,
  opts: CompileOptions = {},
): string {
  const jsx = toJsxSource(source, filename, opts);

  if (backend === "native") {
    // No `syntax` option: rc.7's README and `types.d.ts` both document
    // `syntax: "auto" | "jsx" | "tsrx"`, but the shipped runtime rejects it
    // ("received unknown option `syntax`"). Routing is by filename anyway,
    // and neither `.tsx` nor `.solid.mx` is `.tsrx`, so the JSX frontend is
    // what runs. Revisit when the option is actually wired up.
    //
    // The filename must end in an extension the native compiler recognises
    // (`.js/.mjs/.jsx/.cjs/.ts/.d.ts/.mts/.cts/.tsx`) — it picks its parser
    // dialect from the extension and rejects `.solid.mx` outright. Appending
    // `.tsx` is the same trick `@mxlang/vite-plugin` uses on its virtual id, and
    // it is what a real MX consumer hands the compiler.
    const result = nativeTransform(jsx, {
      filename: isMxPath(filename) ? `${filename}.tsx` : filename,
      generate: variant.generate,
      hydratable: variant.hydratable,
    });
    if (!result?.code) {
      throw new Error(`@solidjs/compiler produced no output for ${filename}`);
    }
    return result.code;
  }

  const result = transformSync(jsx, {
    filename,
    plugins: [
      [
        solidBabelPlugin,
        { generate: variant.generate, hydratable: variant.hydratable },
      ],
    ],
    babelrc: false,
    configFile: false,
  });

  if (!result?.code) {
    throw new Error(`@solidjs/babel-plugin produced no output for ${filename}`);
  }

  return result.code;
}

export function compileFile(
  path: string,
  variant: SolidVariant,
  backend: SolidBackend,
  opts: CompileOptions = {},
): string {
  const source = readFileSync(path, "utf8");
  return compile(source, path, variant, backend, opts);
}
