/**
 * The Babel core lowers, prints and strips TypeScript with (decision 197,
 * PR 6 slice S1): stock `@babel/*` packages, exact-pinned runtime
 * dependencies of `@mxlang/core` and external to its bundle. It replaces
 * `@marko/compiler`'s bundled Babel (`markoBabel()`), which was the same
 * packages at 7.29.7 plus Marko's patches; the patches only teach the
 * generator, traverse and types about `Marko*` nodes, which MX payloads never
 * are.
 *
 * `traverse` and `types` come from `@babel/core`'s own exports, so the
 * `File` that `stripMxTypes` builds, its paths and scopes, and the traversal
 * that walks them are one Babel instance whatever the install dedupes.
 *
 * Loaded lazily on first use: importing core (the registry's light-import
 * invariant) must not load Babel. The interface is untyped (`Node`) so the
 * published `.d.ts` names no `@babel/*` type.
 *
 * The parser and the TS strip plugin load on their own memos, apart from the
 * `@babel/core` graph (the cold-start work, decision on `perf/core-cold-start`):
 * a path that only parses expressions (mapping, the reserved-binding check)
 * pays for `@babel/parser` alone, and a file with no TypeScript never pays
 * for `@babel/plugin-transform-typescript`.
 */
import { createRequire } from "node:module";
import type { Node } from "./core.ts";

/** Parser, traverse, types, generator, code frame and the TS strip plugin. */
export interface Babel {
  parse: (code: string, options?: Node) => Node;
  parseExpression: (code: string, options?: Node) => Node;
  traverse: Node;
  types: Node;
  generator: (node: Node, options?: Node) => { code: string };
  codeFrameColumns: (rawLines: string, loc: Node, options?: Node) => string;
  File: new (options: Node, input: { code: string; ast: Node }) => Node;
}

const require = createRequire(import.meta.url);

/** A CommonJS module's default export (`exports.default` when it has one). */
function defaultOf<T>(loaded: { __esModule?: boolean; default?: T } & T): T {
  return loaded.__esModule && loaded.default !== undefined
    ? loaded.default
    : loaded;
}

/** `@babel/plugin-transform-typescript`'s plugin factory. */
type PluginTransformTypeScript = (api: Node, options: Node) => Node;

let tsPlugin: PluginTransformTypeScript | undefined;

/** The slice of `@babel/parser` core calls directly. */
interface Parser {
  parse: Babel["parse"];
  parseExpression: Babel["parseExpression"];
}

let parser: Parser | undefined;

/**
 * `@babel/parser`, loaded on first call: importing core must not load any
 * Babel package (the registry's light-import invariant), and a path that
 * never parses must not pay for the parser either.
 */
export function coreParser(): Parser {
  parser ??= require("@babel/parser") as Parser;
  return parser;
}

/**
 * `@babel/plugin-transform-typescript`'s plugin factory, loaded on first
 * call: a file with no TypeScript is stripped without it (the TS-free fast
 * path in `mx-parse.ts`), so it must not load even with the rest of Babel.
 */
export function coreTsPlugin(): PluginTransformTypeScript {
  if (!tsPlugin) {
    const plugin = defaultOf(
      require("@babel/plugin-transform-typescript"),
    ) as PluginTransformTypeScript;
    tsPlugin = plugin;
  }
  return tsPlugin;
}

let loaded: Babel | undefined;

/**
 * The one Babel instance core uses, loaded on first call. Every package is
 * required with a literal specifier: a bundle that inlines core (the VSIX
 * builds) leaves them external and ships them, and `check-vsix` finds each
 * one by its `require("…")`.
 */
export function coreBabel(): Babel {
  if (loaded) return loaded;
  const core = require("@babel/core") as {
    File: Babel["File"];
    traverse: Node;
    types: Node;
  };
  const { parse, parseExpression } = coreParser();
  loaded = {
    parse,
    parseExpression,
    traverse: core.traverse,
    types: core.types,
    generator: defaultOf(require("@babel/generator")),
    codeFrameColumns: (
      require("@babel/code-frame") as {
        codeFrameColumns: Babel["codeFrameColumns"];
      }
    ).codeFrameColumns,
    File: core.File,
  };
  return loaded;
}
