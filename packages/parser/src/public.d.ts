/**
 * Public types for `@mxlang/parser` as seen by other packages.
 *
 * Consumers typecheck against this rather than against `src/index.ts`, because
 * the vendored `@babel/parser` source under `src/babel/` needs relaxations
 * (`allowImportingTsExtensions`, looser index/variance checks) that should not
 * leak into every package that merely calls `parse`.
 */
declare module "@mxlang/parser" {
  import type { Expression, File } from "@babel/types";

  // Re-exported, not re-declared: `MxRegionContext`/`MxRegionPositionCheck`
  // are the real shapes `mx/region-context.ts` computes and calls, so a
  // hand-duplicated copy here could silently drift from what the parser
  // actually produces (round 3 review). `src/mx/region-context.ts` is
  // outside `src/babel/`, so it needs none of this file's tsconfig
  // relaxations — importing it directly is safe.
  export type {
    MxRegionContext,
    MxRegionPositionCheck,
  } from "./mx/region-context.ts";

  export interface MxParseOptions {
    sourceType?: "script" | "module" | "unambiguous";
    plugins?: unknown[];
    /**
     * Custom tags, carried across the parser boundary to the Solid host.
     *
     * Declared explicitly despite the index signature below: this is the only
     * channel the in-tokenizer MX bridge has to the caller, and a misspelling
     * would otherwise be accepted and silently never read — the exact failure
     * the P1 review hit when the option was first added.
     */
    mxCustomTags?: Record<string, unknown>;
    /**
     * A host's veto on where an MX region may appear (e.g. Angular's
     * `.ng.mx` only allowing one as `@Component({ template: … })`'s value).
     * Declared explicitly for the same reason as `mxCustomTags` above.
     */
    mxRegionPositionCheck?: MxRegionPositionCheck;
    [option: string]: unknown;
  }

  /**
   * Parses a `.solid.mx` file into a Babel `File` of standard node types.
   *
   * Whole-file `.mx` templates are not parsed here: `@mxlang/html`
   * drives `@marko/compiler` with its own translator instead (ADR 0001).
   */
  export function parse(
    source: string,
    filename: string,
    options?: MxParseOptions,
  ): File;

  /**
   * Parses the file and collects every MX region's absolute [start, end)
   * source offsets, read off each region root's `extra.mx.range`.
   */
  export function collectMxRegions(
    source: string,
    filename: string,
    options?: MxParseOptions,
  ): Array<{ start: number; end: number }>;

  export interface MxRange {
    start: number;
    end: number;
  }

  export interface MxTagName extends MxRange {
    quasis: MxRange[];
    expressions: MxRange[];
  }

  export type MxAttr =
    | { kind: "static"; name: string; nameRange: MxRange; value: MxRange }
    | { kind: "dynamic"; name: string; nameRange: MxRange; value: MxRange }
    | { kind: "boolean"; name: string; nameRange: MxRange }
    | {
        kind: "method";
        name: string;
        nameRange: MxRange;
        params: MxRange;
        body: MxRange;
        async: boolean;
        range: MxRange;
      }
    | { kind: "spread"; value: MxRange; range: MxRange }
    | { kind: "bound"; name: string; nameRange: MxRange; value: MxRange };

  export type MxChild =
    | { kind: "text"; range: MxRange }
    | {
        kind: "placeholder";
        range: MxRange;
        value: MxRange;
        escape: boolean;
      }
    | { kind: "element"; element: MxElement }
    | { kind: "comment"; range: MxRange }
    /** `<!doctype html>`; only reachable in template mode. */
    | { kind: "doctype"; range: MxRange };

  export interface MxElement {
    name: MxTagName;
    staticName: string | null;
    attrs: MxAttr[];
    children: MxChild[];
    selfClosing: boolean;
    shorthandClasses: MxRange[];
    shorthandIds: MxRange[];
    params: MxRange | null;
    tagArgs: MxRange | null;
    tagVar: MxRange | null;
    range: MxRange;
    closeRange: MxRange | null;
  }

  export interface MxWalkError {
    message: string;
    start: number;
    end: number;
  }

  /** True for an HTML void element, which takes no closing tag. */
  export function isVoidTag(name: string | null): boolean;

  /** The vendored `@babel/parser` entry points, for plain `.ts`/`.tsx`. */
  export function parseBabel(input: string, options?: MxParseOptions): File;
  export function parseBabelExpression(
    input: string,
    options?: MxParseOptions,
  ): Expression;

  /** A source map as `@babel/generator` emits it, which is what Vite accepts. */
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
     * Forwarded through the parser to the Solid host, which lowers each MX
     * region; without it a registered tag is unknown inside `.solid.mx`.
     */
    customTags?: Record<string, unknown>;
  }

  /**
   * Parses `source` and prints it back as JSX source text plus a source map.
   * This is the artifact every consumer receives (spec section 3.2): the
   * native Solid 2 compiler accepts only source text, never an AST.
   */
  export function print(
    source: string,
    filename: string,
    options?: PrintOptions,
  ): PrintResult;

  /**
   * Prints an already-parsed MX AST, for callers that must run their own pass
   * over it first and cannot re-parse afterwards — the oracle strips
   * TypeScript with `@babel/preset-typescript` before printing, since the
   * native compiler's JSX frontend has no TypeScript to erase. Shares
   * `print`'s generator options.
   */
  export function printAst(ast: File, filename: string): PrintResult;
}
