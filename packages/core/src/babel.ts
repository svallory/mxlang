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
 */
import { createRequire } from "node:module";
import { parse, parseExpression } from "@babel/parser";
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
  pluginTransformTypeScript: (api: Node, options: Node) => Node;
}

const require = createRequire(import.meta.url);

/** A CommonJS module's default export (`exports.default` when it has one). */
function defaultOf<T>(loaded: { __esModule?: boolean; default?: T } & T): T {
  return loaded.__esModule && loaded.default !== undefined
    ? loaded.default
    : loaded;
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
  loaded = {
    parse: parse as Babel["parse"],
    parseExpression: parseExpression as Babel["parseExpression"],
    traverse: core.traverse,
    types: core.types,
    generator: defaultOf(require("@babel/generator")),
    codeFrameColumns: (
      require("@babel/code-frame") as {
        codeFrameColumns: Babel["codeFrameColumns"];
      }
    ).codeFrameColumns,
    File: core.File,
    pluginTransformTypeScript: defaultOf(
      require("@babel/plugin-transform-typescript"),
    ),
  };
  return loaded;
}
