/**
 * The one place `@mxlang/core` loads Marko's parse layer: `@marko/compiler`,
 * its bundled Babel (`@marko/compiler/internal/babel`) and the `htmljs-parser`
 * that compiler parses with.
 *
 * Since port PR 5 core parses templates with the MX front end
 * (`@mxlang/parser/frontend`, `mx-parse.ts`), not with this layer, and so
 * does `@mxlang/data`'s tag scan (`parseMxDocument`): no production call site
 * compiles or parses a template with `@marko/compiler`. What is still loaded
 * here is the taglib lookup (`taglib.buildLookup`) and, in the
 * dist only, the bundle's copy of MX's template parser for the syntax table
 * (`mxTemplateParser`). The error-path re-lexes use `@mxlang/parser/lexer`
 * directly (PR 6 slice S2); printing, the TS strip, code frames and the
 * error kit use core's own Babel (`babel.ts`, slice S1), and `markoBabel()`
 * is left only for the differential in `babel.test.ts`. Nothing calls
 * `compileSync` (`parseFragmentNative` delegates to `parseFragment`). The
 * whole file goes with the Marko readers in PR 6 (decision 197, slice S5).
 *
 * Decision 159. Until then core's build bundles that layer into
 * `dist/marko-frontend.cjs`, with the `htmljs-parser` specifier resolved to
 * MX's own template parser (`packages/parser/src/template/`). The build
 * defines `MX_MARKO_FRONTEND` as that file's path relative to
 * `dist/index.js`, so a registry install of core installs no npm
 * `htmljs-parser` at all.
 *
 * From source (this repo's tests and tools) `MX_MARKO_FRONTEND` is undefined
 * and the three modules come from the workspace install, where the root
 * `patchedDependencies` entry gives `htmljs-parser` the same rules
 * (`packages/parser/src/template/corpus-equivalence.test.ts` pins that).
 *
 * Every package that needs Marko's compiler or its Babel goes through these
 * functions (re-exported from the package index), so one compiler and one
 * Babel instance load per process: nodes, taglib caches and compile state
 * are per instance.
 *
 * Each piece is required lazily: importing core's type surface, or a target
 * descriptor, loads none of it.
 */

import { createRequire } from "node:module";
import type { Node } from "./core.ts";
import type { SyntaxDiagnostic, SyntaxTable } from "./syntax-table.ts";

/** Set by core's build (`build/frontend.ts`); undefined when running from source. */
declare const MX_MARKO_FRONTEND: string | undefined;

/**
 * The part of `@marko/compiler`'s module MX calls. Declared here rather than
 * as `typeof import("@marko/compiler")`: a registry install of core has no
 * `@marko/compiler` package to type against, since the compiler is bundled.
 * Results are Marko's untyped nodes and lookups (`Node`).
 */
export interface MarkoCompiler {
  compileSync(
    source: string,
    filename: string,
    config?: Record<string, unknown>,
  ): Node;
  taglib: {
    buildLookup(dir: string, translator?: unknown): Node;
    clearCaches?(): void;
  };
  types: Node;
}

/** `@marko/compiler/internal/babel`: parser, traverse, types and generator of Marko's own Babel. */
export interface MarkoBabel {
  parse: (code: string, options?: Node) => Node;
  parseExpression: (code: string, options?: Node) => Node;
  traverse: Node;
  types: Node;
  generator: (node: Node, options?: Node) => { code: string };
  codeFrameColumns: (rawLines: string, loc: Node, options?: Node) => string;
  File: new (options: Node, input: { code: string; ast: Node }) => Node;
  pluginTransformTypeScript: (api: Node, options: Node) => Node;
}

interface Frontend {
  compiler: MarkoCompiler;
  babel: MarkoBabel;
  /** MX's template parser: `build/frontend.ts` resolves `htmljs-parser` to it. */
  htmljsParser: unknown;
}

const require = createRequire(import.meta.url);

/*
 * Each function picks its branch with a conditional on `MX_MARKO_FRONTEND`,
 * which the build replaces with a string literal: Bun folds the conditional,
 * so the dist keeps only the bundle branch and names no `@marko/compiler`
 * (a dead `require("@marko/compiler")` left in the dist would still be read as
 * a dependency by anything that scans it, `check-vsix` among them).
 */

let bundled: Frontend | undefined;

/** The bundled parse layer; only reached in the dist. */
function bundledFrontend(path: string): Frontend {
  bundled ??= require(path) as Frontend;
  return bundled;
}

/** `@marko/compiler`: `compileSync`, `taglib`, `types`, ... */
export function markoCompiler(): MarkoCompiler {
  return typeof MX_MARKO_FRONTEND === "string"
    ? bundledFrontend(MX_MARKO_FRONTEND).compiler
    : (require("@marko/compiler") as MarkoCompiler);
}

/**
 * Marko's own bundled Babel — parser, traverse, types and generator in one
 * module. Nodes Marko produced belong to this instance.
 */
export function markoBabel(): MarkoBabel {
  return typeof MX_MARKO_FRONTEND === "string"
    ? bundledFrontend(MX_MARKO_FRONTEND).babel
    : (require("@marko/compiler/internal/babel") as MarkoBabel);
}

/**
 * MX's own template parser with its syntax-table API (decision 182):
 * `createParser(handlers, { syntax })`, `validateSyntaxTable`,
 * `DEFAULT_SYNTAX`. In the dist it is the bundle's parser, which is
 * `packages/parser/src/template` already; from source it is that workspace
 * package (a devDependency), loaded by `require`, so no parser source enters
 * core's type program and the published `.d.ts` never names it. Never
 * Marko's parser from source: that is the patched npm `htmljs-parser`, which
 * has no syntax table.
 */
export function mxTemplateParser(): MxTemplateParser {
  return typeof MX_MARKO_FRONTEND === "string"
    ? (bundledFrontend(MX_MARKO_FRONTEND)
        .htmljsParser as unknown as MxTemplateParser)
    : (require("@mxlang/parser") as MxTemplateParser);
}

/** The slice of the MX template parser's entry that core uses (decision 182). */
export interface MxTemplateParser {
  createParser(
    handlers: Record<string, unknown>,
    options?: { syntax?: SyntaxTable },
  ): { parse(source: string): void };
  validateSyntaxTable(table: unknown): SyntaxDiagnostic[];
  DEFAULT_SYNTAX: SyntaxTable;
}
