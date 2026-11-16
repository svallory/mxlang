/**
 * The Babel core lowers, prints and strips TypeScript with.
 *
 * `parse`/`parseExpression` are MX's `@babel/parser` fork (`@mxlang/babel`),
 * reached through `@mxlang/parser/frontend/babel`. With no `mx*` option the
 * fork parses as npm `@babel/parser` 7.29.8 does, but its block-comment scan
 * is linear, so a line with many block comments does not make a re-parse
 * quadratic. The subpath resolves to the parser package's built
 * `dist/babel.js`, which plain Node loads (the fork's source uses
 * `const enum`s and accessor decorators that Node's type stripping cannot
 * run); core's own build passes the `mx-source` condition and bundles the
 * fork's source, the same copy `mx-parse.ts` already bundles. npm
 * `@babel/parser` stays a dependency for core's type-only imports and for
 * `@babel/core`, but core never calls it.
 *
 * `traverse`, `types` and `File` come from `@babel/core`'s own exports, so
 * the `File` that `stripMxTypes` builds, its paths and scopes, and the
 * traversal that walks them are one Babel instance whatever the install
 * dedupes. `@babel/core`, the generator, the code frame and the TS strip
 * plugin are stock, exact-pinned runtime dependencies, external to core's
 * bundle. They replace `@marko/compiler`'s bundled Babel (`markoBabel()`),
 * which was the same packages at 7.29.7 plus Marko's patches; the patches
 * only teach the generator, traverse and types about `Marko*` nodes, which
 * MX payloads never are.
 *
 * The stock packages load lazily on first use: importing core (the
 * registry's light-import invariant) must not load `@babel/core`. The
 * interface is untyped (`Node`) so the published `.d.ts` names no
 * `@babel/*` type.
 *
 * The TS strip plugin loads on its own memo, apart from the `@babel/core`
 * graph: it loads only when a payload is stripped — which every lowering
 * with an expression payload runs, TypeScript or not.
 */
import { createRequire } from "node:module";
import { stripVTControlCharacters } from "node:util";
import {
  parseBabel,
  parseBabelExpression,
} from "@mxlang/parser/frontend/babel";
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

/** The slice of the parser core calls directly. */
interface Parser {
  parse: Babel["parse"];
  parseExpression: Babel["parseExpression"];
}

let parser: Parser | undefined;

/**
 * MX's `@babel/parser` fork, the parser every core parse goes through. A
 * static import, not a run-time `require`: core's build bundles only what it
 * can see, and the parser package is private, so a published dist could not
 * resolve it.
 */
export function coreParser(): Parser {
  parser ??= { parse: parseBabel, parseExpression: parseBabelExpression };
  return parser;
}

/**
 * `@babel/plugin-transform-typescript`'s plugin factory, loaded on the first
 * strip: the strip runs for every payload, TypeScript or not, so the plugin
 * loads with the first lowering — but importing core never loads it.
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

/** The reason a code frame's caret line carries (`    | ^^^ <reason>`), ANSI-free. */
const CARET_REASON = /^\s*\|\s*\^+\s+(\S.*)$/;

/**
 * The reason of a Babel/Marko parse error: its `label` when it has one, else
 * the text on the first caret line of its code frame (an aggregate's first
 * error carries it). `undefined` when the message holds neither.
 */
function reasonOf(error: Error): string | undefined {
  const { label, errors } = error as { label?: unknown; errors?: unknown };
  if (typeof label === "string" && label.trim() !== "") return label.trim();
  if (Array.isArray(errors) && errors[0] instanceof Error) {
    const first = reasonOf(errors[0]);
    if (first !== undefined) return first;
  }
  for (const line of stripVTControlCharacters(error.message).split("\n")) {
    const reason = CARET_REASON.exec(line)?.[1];
    if (reason !== undefined) return reason.trim();
  }
  return undefined;
}

/** `error.stack` with its header (`Name: message`) swapped for the new message, keeping the original's frames. */
function restack(error: Error, message: string): string | undefined {
  const header = `${error.name}: ${error.message}`;
  return typeof error.stack === "string" && error.stack.startsWith(header)
    ? `${error.name}: ${message}${error.stack.slice(header.length)}`
    : error.stack;
}

/**
 * A parse error whose `.message` starts with its reason.
 *
 * Babel and Marko write `<empty line>\n    at <file>:L:C\n<code frame>`, with the
 * reason on the frame's caret line, so anything that reads the first line of
 * the message sees nothing or a path. The result is a copy of `error` (same
 * class, same properties, `error` itself is not touched, and a printer of the
 * original keeps its text) whose message is the reason, then the old message
 * without its leading blank line. An error whose message already starts with
 * text, or that carries no reason, is returned as is.
 */
export function withReasonFirst<E extends Error>(error: E): E {
  if (error.message.split("\n", 1)[0]?.trim() !== "") return error;
  const reason = reasonOf(error);
  if (reason === undefined) return error;
  const message = `${reason}\n${error.message.replace(/^\s*\n/, "")}`;
  const copy = Object.create(
    Object.getPrototypeOf(error),
    Object.getOwnPropertyDescriptors(error),
  ) as E;
  Object.defineProperties(copy, {
    message: {
      value: message,
      enumerable: false,
      writable: true,
      configurable: true,
    },
    stack: {
      value: restack(error, message),
      enumerable: false,
      writable: true,
      configurable: true,
    },
  });
  return copy;
}
