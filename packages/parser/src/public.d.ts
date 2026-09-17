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

  // Declared inline rather than re-exported through a relative import: a
  // relative import/re-export inside an ambient `declare module` block is
  // TS2439 ("Import or export declaration in an ambient module declaration
  // cannot reference module through relative module name"), which every
  // consumer's `skipLibCheck: true` silently swallows — every name below
  // degraded to `any` in every host (measured: `const bad: MxRegionContext =
  // { nope: 1 }` typechecked). `public-types.test.ts` asserts two-way
  // assignability against the real shapes in `src/mx/*.ts` so this copy
  // cannot drift unnoticed.

  /** Where a region appeared, described without host-specific knowledge. */
  export interface MxRegionContext {
    /** Innermost enclosing object-property key, or null. */
    propertyKey: string | null;
    /** The innermost enclosing decorator's own name, as a single-element
     *  list, or `[]` when none. */
    decoratorNames: readonly string[];
    /** Every decorator enclosing the region other than the innermost one,
     *  outermost first. Empty when there is one decorator or none. */
    enclosingDecoratorNames: readonly string[];
    /** The decorator-call argument index enclosing the region, or null. */
    argumentIndex: number | null;
    /** True iff the region is the immediate value of a property of the
     *  decorator argument object itself. */
    isDirectPropertyValue: boolean;
  }

  /** A host's veto on a region's syntactic position. */
  export type MxRegionPositionCheck = (
    context: MxRegionContext,
  ) => { ok: true } | { ok: false; message: string };

  /** One synthesized import a region needs written into its module. */
  export interface MxRegionHoistedImport {
    /** The `import X from "./y.mx"` statement text. */
    code: string;
    /** The local binding the emitted region references. */
    binding: string;
    /** The module specifier, as written in `code`. */
    specifier: string;
    /** The template's resolved absolute path. */
    resolvedPath: string;
  }

  /** The region text and its file-relative position, as the bridge found it. */
  export interface MxRegionCompileInput {
    /** The region's own source text, `source.slice(start, end)`. */
    source: string;
    /** The file being parsed, from `sourceFilename`. */
    filename: string;
    /** The region's absolute start offset in the file. */
    baseOffset: number;
    /** The region's 0-based start line in the file. */
    baseLine: number;
    /** The region's 0-based start column on that line. */
    baseColumn: number;
    /** Custom tag definitions the caller registered, opaque here. */
    // biome-ignore lint/suspicious/noExplicitAny: `@mxlang/core`'s CustomTag would be a cycle
    customTags?: Record<string, any>;
    /** Where this region appeared, the same context `mxRegionPositionCheck`
     *  was given. Undefined when no `mxRegionPositionCheck` is set. */
    context?: MxRegionContext;
  }

  /** What the bridge needs back from a host. */
  export interface MxRegionCompileResult {
    /** The lowered region, as source text the surrounding grammar can parse. */
    code: string;
    /** Imports the compiler minted for discovered tags called inside this
     *  region. */
    hoistedImports?: MxRegionHoistedImport[];
    /** `/var` names this region's call sites bind, for the caller to declare. */
    returnVars?: string[];
  }

  /** Lowers one MX region to text the surrounding grammar can parse. */
  export type MxRegionCompile = (
    input: MxRegionCompileInput,
  ) => MxRegionCompileResult;

  export interface MxParseOptions {
    sourceType?: "script" | "module" | "unambiguous";
    plugins?: unknown[];
    /**
     * Custom tags, carried across the parser boundary to whichever host
     * lowers each MX region.
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
    /**
     * Lowers each MX region the bridge finds. The parser has no host of its
     * own: with the grammar on, an absent hook is a compile error at the
     * first region naming this option. For `.solid.mx`, pass `compileSolidMx`
     * from `@mxlang/solid`. Declared explicitly for the same reason as
     * `mxCustomTags` above.
     */
    mxRegionCompile?: MxRegionCompile;
    /**
     * Turns the MX grammar on explicitly, for a caller owning a file kind
     * whose extension `parse`'s own `.solid.mx` test would not match. Unset,
     * that test still decides.
     */
    mx?: boolean;
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
     * Forwarded through the parser to whichever host lowers each MX region;
     * without it a registered tag is unknown inside the region.
     */
    customTags?: Record<string, unknown>;
    /**
     * Lowers each MX region the bridge finds. Required whenever the grammar
     * is on. For `.solid.mx`, pass `compileSolidMx` from `@mxlang/solid`.
     */
    mxRegionCompile?: MxRegionCompile;
    /** Turns the MX grammar on explicitly, forwarded to `parse` unchanged. */
    mx?: boolean;
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
