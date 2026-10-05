import type { Options } from "./options.ts";
import {
  validatePlugins,
  mixinPluginNames,
  mixinPlugins,
} from "./plugin-utils.ts";
export type {
  PluginConfig as ParserPlugin,
  DecoratorsPluginOptions,
  FlowPluginOptions,
  PipelineOperatorPluginOptions,
  RecordAndTuplePluginOptions,
  TypeScriptPluginOptions,
} from "./typings.ts";
import Parser, { type PluginsMap } from "./parser/index.ts";
import type { ParseError as ParseErrorGeneric } from "./parse-error.ts";
import type { MxHooks } from "./mx-hooks.ts";
import { Position } from "./util/location.ts";

import type { ExportedTokenType } from "./tokenizer/types.ts";
import {
  getExportedToken,
  tt as internalTokenTypes,
  type InternalTokenTypes,
} from "./tokenizer/types.ts";
export type { Token } from "./tokenizer/index.ts";
export type * from "./mx-hooks.ts";

// TODO: Rather than type-casting the internal AST definitions to the
// @babel/types one, we should actually unify them.
import type { Expression, File } from "@babel/types";
export type { Expression, File };

export type ParserOptions = Partial<Options>;

export type ParseError = ParseErrorGeneric<object>;
export type ParseResult<Result extends File | Expression = File> = Result & {
  comments: File["comments"];
  errors: null | ParseError[];
  tokens?: File["tokens"];
};

/**
 * Parse the provided code as an entire ECMAScript program.
 *
 * With the MX grammar on, a failure caused by a region's second root
 * (`<a/><b/>`) is reported as the rule it breaks instead of as the Babel
 * error the tokenizer happens to hit. Only failures are touched.
 */
export function parse(
  input: string,
  options?: ParserOptions,
): ParseResult<File> {
  if (options?.mx !== true) return parseProgram(input, options);
  const siblingHints: Array<{ start: number; end: number }> = [];
  try {
    return parseProgram(input, { ...options, mxSiblingHints: siblingHints });
  } catch (error) {
    throw withMultipleRootsError(
      error,
      siblingHints,
      input,
      options.mxHooks as MxHooks,
    );
  }
}

/**
 * Replaces `error` with `MxErrors.MultipleRoots`, at the second root, when the
 * error is Babel's own (not one MX raised) and its position falls inside a
 * sibling root the bridge saw directly after a region. Anything else is
 * returned unchanged.
 */
function withMultipleRootsError(
  error: unknown,
  hints: ReadonlyArray<{ start: number; end: number }>,
  input: string,
  hooks: MxHooks,
): unknown {
  const { pos, syntaxPlugin } = (error ?? {}) as {
    pos?: unknown;
    syntaxPlugin?: unknown;
  };
  if (typeof pos !== "number") return error;
  // An error MX itself raised (a host's, a walk's) is already the better
  // message. It can share a position with a hint left by a speculative
  // re-parse — `<div><p/><else/></div>` is retried by TypeScript's generic-
  // arrow disambiguation, whose second attempt reads `<p/>` as a region.
  if (syntaxPlugin === "mx") return error;
  const hint = hints.find((h) => pos >= h.start && pos <= h.end);
  if (!hint) return error;
  const before = input.slice(0, hint.start);
  const line = before.split("\n").length;
  const column = hint.start - (before.lastIndexOf("\n") + 1);
  return hooks.multipleRootsError(new Position(line, column, hint.start));
}

function parseProgram(
  input: string,
  options?: ParserOptions,
): ParseResult<File> {
  if (options?.sourceType === "unambiguous") {
    options = {
      ...options,
    };
    try {
      options.sourceType = "module";
      const parser = getParser(options, input);
      const ast = parser.parse();

      if (parser.sawUnambiguousESM) {
        return ast;
      }

      if (parser.ambiguousScriptDifferentAst) {
        // Top level await introduces code which can be both a valid script and
        // a valid module, but which produces different ASTs:
        //    await
        //    0
        // can be parsed either as an AwaitExpression, or as two ExpressionStatements.
        try {
          options.sourceType = "script";
          return getParser(options, input).parse();
        } catch {}
      } else {
        // This is both a valid module and a valid script, but
        // we parse it as a script by default
        ast.program.sourceType = "script";
      }

      return ast;
    } catch (moduleError) {
      try {
        options.sourceType = "script";
        return getParser(options, input).parse();
      } catch {}

      throw moduleError;
    }
  } else {
    return getParser(options, input).parse();
  }
}

export function parseExpression(
  input: string,
  options?: ParserOptions,
): ParseResult<Expression> {
  const parser = getParser(options, input);
  if (parser.options.strictMode) {
    parser.state.strict = true;
  }
  return parser.getExpression() as ParseResult<Expression>;
}

function generateExportedTokenTypes(
  internalTokenTypes: InternalTokenTypes,
): Record<string, ExportedTokenType> {
  const tokenTypes: Record<string, ExportedTokenType> = {};
  for (const typeName of Object.keys(
    internalTokenTypes,
  ) as (keyof InternalTokenTypes)[]) {
    tokenTypes[typeName] = getExportedToken(internalTokenTypes[typeName]);
  }
  return tokenTypes;
}

export const tokTypes = generateExportedTokenTypes(internalTokenTypes);

function getParser(
  options: ParserOptions | undefined | null,
  input: string,
): Parser {
  if (options?.mx === true && !options.mxHooks) {
    throw new Error(
      "MX: `mx: true` needs `mxHooks`, which the Babel fork does not supply itself. " +
        "Parse through @mxlang/tsx-bridge, or pass its `mxHooks` option.",
    );
  }
  let cls = Parser;
  const pluginsMap: PluginsMap = new Map();
  if (options?.plugins) {
    for (const plugin of options.plugins) {
      let name, opts;
      if (typeof plugin === "string") {
        name = plugin;
      } else {
        [name, opts] = plugin;
      }
      if (!pluginsMap.has(name)) {
        pluginsMap.set(name, opts || {});
      }
    }
    validatePlugins(pluginsMap);
    cls = getParserClass(pluginsMap);
  }

  return new cls(options, input, pluginsMap);
}

const parserClassCache = new Map<string, new (...args: any) => Parser>();

/** Get a Parser class with plugins applied. */
function getParserClass(
  pluginsMap: Map<string, any>,
): new (...args: any) => Parser {
  const pluginList = [];
  for (const name of mixinPluginNames) {
    if (pluginsMap.has(name)) {
      pluginList.push(name);
    }
  }
  const key = pluginList.join("|");
  let cls = parserClassCache.get(key)!;
  if (!cls) {
    cls = Parser;
    for (const plugin of pluginList) {
      // @ts-expect-error todo(flow->ts)
      cls = mixinPlugins[plugin](cls);
    }
    parserClassCache.set(key, cls);
  }
  return cls;
}
