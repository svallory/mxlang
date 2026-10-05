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
  // Type-only. `@mxlang/core` has no runtime dependency on the parser and
  // nothing in core's emitted declarations references it (the only core -> parser
  // edge is a type-only test fixture, excluded from core's build).
  import type { CustomTag } from "@mxlang/core";

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
    /**
     * True when the region is a fragment (`<>…</>`) claimed through
     * `mxRegionFragment`. Absent (not `false`) for an ordinary region and
     * whenever the option is off. Set by the bridge after the position is
     * computed, so a position check can word a fragment differently:
     * `@mxlang/angular` uses it to say a fragment is only allowed as the root
     * of a `template:` region.
     */
    fragment?: boolean;
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

  /** One `<define>` a region hoisted to module scope (decision 110b). */
  export interface MxRegionHoistedDefine {
    /** The `function __mx_DefineN(params) { return <>...</>; }` text. */
    code: string;
    /** The gensym'd module-scope binding the region calls. */
    binding: string;
  }

  /** The region text and its file-relative position, as the bridge found it. */
  export interface MxRegionCompileInput {
    /** The region's own source text, `source.slice(start, end)`. */
    source: string;
    /** The file being parsed, from `sourceFilename`. */
    filename: string;
    /**
     * True for a fragment region (`<>…</>`, `mxRegionFragment`): `source` is the
     * fragment's children only, and the span the bridge replaces also covers the
     * `<>` before them (2 characters) and the `</>` after (3).
     */
    fragment?: boolean;
    /** The region's absolute start offset in the file. */
    baseOffset: number;
    /** The region's 0-based start line in the file. */
    baseLine: number;
    /** The region's 0-based start column on that line. */
    baseColumn: number;
    /** Custom tag definitions the caller registered, keyed by tag name. */
    customTags?: Record<string, CustomTag>;
    /** `package.json#mx.<target>.defaultTag` the caller resolved (decision 145). */
    defaultTag?: string;
    /** Where this region appeared, the same context `mxRegionPositionCheck`
     *  was given. Undefined when no `mxRegionPositionCheck` is set. */
    context?: MxRegionContext;
    /** Imports declared by the surrounding module, local binding -> specifier. */
    importSpecifiers: ReadonlyMap<string, string>;
    /** Every value the surrounding module binds at its top level (decision 114). */
    moduleBindings: ReadonlySet<string>;
    /** The subset of `importSpecifiers`' bindings that are a default import
     *  from a `.marko`/`.mx` source — Marko's own statically-resolved
     *  component case (decision 116). */
    importDefaultFromMarkoOrMx: ReadonlySet<string>;
    /** The subset of `moduleBindings`' non-import names whose value is not
     *  statically a function/arrow/class — the local extension of decision
     *  116. */
    unknownModuleBindings: ReadonlySet<string>;
  }

  /** What the bridge needs back from a host. */
  export interface MxRegionCompileResult {
    /** The lowered region, as source text the surrounding grammar can parse. */
    code: string;
    /** Imports the compiler minted for discovered tags called inside this
     *  region. */
    hoistedImports?: MxRegionHoistedImport[];
    /** `<define>`s the region hoisted to module scope (decision 110b). */
    hoistedDefines?: MxRegionHoistedDefine[];
    /** `/var` names this region's call sites bind, for the caller to declare. */
    returnVars?: string[];
    /** Files read while resolving callees used by this region. */
    dependencies?: string[];
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
    mxCustomTags?: Record<string, CustomTag>;
    /** `package.json#mx.<target>.defaultTag`, forwarded to the host that lowers each region. */
    mxDefaultTag?: string;
    /**
     * A host's veto on where an MX region may appear (e.g. Angular's
     * `.ng.mx` only allowing one as `@Component({ template: … })`'s value).
     * Declared explicitly for the same reason as `mxCustomTags` above.
     */
    mxRegionPositionCheck?: MxRegionPositionCheck;
    /**
     * Makes `<>…</>` in expression position an MX **fragment region**: the
     * host receives the fragment's *children* as `MxRegionCompileInput.source`
     * (the `<>`/`</>` themselves are not part of it) and lowers them as sibling
     * nodes, exactly as it lowers a whole-file template with several roots.
     * A fragment with no MX child (`<></>`, `<>text</>`) is a region too.
     *
     * Default `false`: `<>` stays a TSX `JSXFragment`, which is what
     * `.solid.mx` wants, since its output is JSX. `@mxlang/angular` enables it
     * for `.ng.mx`, where an Angular template has no TSX to fall back to.
     * Declared explicitly for the same reason as `mxCustomTags` above.
     */
    mxRegionFragment?: boolean;
    /**
     * Lowers each MX region the bridge finds. The parser has no host of its
     * own: with the grammar on, an absent hook is a compile error at the
     * first region naming this option. For `.solid.mx`, pass `compileSolidMx`
     * from `@mxlang/solid`. Declared explicitly for the same reason as
     * `mxCustomTags` above.
     */
    mxRegionCompile?: MxRegionCompile;
    /** Internal bridge input populated from the surrounding module. */
    mxImportSpecifiers?: ReadonlyMap<string, string>;
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

  /**
   * Solid JSX built-ins that resolve with no import of their own (decision
   * 114): the real Solid build pipeline auto-imports these, a compiler stage
   * the type-check projection and MX's own resolvability check never run
   * through. Shared by `@mxlang/typescript-plugin` and `@mxlang/solid`.
   */
  export const SOLID_BUILTIN_TAGS: ReadonlyArray<{
    name: string;
    from: string;
  }>;

  /** A `sourceBindings` parse failure, positioned in the source it was given. */
  export interface SourceBindingsError {
    message: string;
    line: number;
    column: number;
  }

  /**
   * Grammar relaxations for source that is *not* a plain ES module — see
   * `source-bindings.ts`'s `SourceBindingsOptions`. `allowReturnOutside-
   * Function` is for authored host module scope the host wraps in a function
   * body (Astro's `---` frontmatter); it is off by default.
   */
  export interface SourceBindingsOptions {
    allowReturnOutsideFunction?: boolean;
  }

  /**
   * The names of every value a piece of TypeScript/TSX source text binds at
   * its top level (imports' local names, top-level `const`/`function`/
   * `class`), excluding type-only bindings. `error` is set only on a parse
   * failure (`bindings` is then empty); a caller that cares can report the
   * real syntax error instead of treating an unparseable file as binding
   * nothing. See `source-bindings.ts` for the full contract.
   */
  export function sourceBindings(
    source: string,
    options?: SourceBindingsOptions,
  ): {
    bindings: Set<string>;
    error?: SourceBindingsError;
  };

  /**
   * Same as `sourceBindings`, over an already-parsed `Program` (a Babel
   * `File`'s `.program`) rather than raw source text — for a caller (like a
   * `.solid.mx` region-nulled pre-pass) that cannot re-parse the raw text
   * with plain `typescript`/`jsx` plugins.
   */
  export function programBindings(program: File["program"]): Set<string>;

  /**
   * The subset of `sourceBindings`' non-import names whose value is not
   * statically a function/arrow/class — the local extension of decision 116.
   * See `source-bindings.ts`'s `unknownProgramBindings` for the full
   * contract.
   */
  export function unknownSourceBindings(
    source: string,
    options?: SourceBindingsOptions,
  ): Set<string>;

  /**
   * Same as `unknownSourceBindings`, over an already-parsed `Program` rather
   * than raw source text.
   */
  export function unknownProgramBindings(program: File["program"]): Set<string>;

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
    dependencies: string[];
  }

  export interface PrintOptions {
    /**
     * Custom tags already discovered and loaded by the calling integration.
     * Forwarded through the parser to whichever host lowers each MX region;
     * without it a registered tag is unknown inside the region.
     */
    customTags?: Record<string, CustomTag>;
    /** `package.json#mx.<target>.defaultTag`, forwarded to the host that lowers each region. */
    defaultTag?: string;
    /**
     * Lowers each MX region the bridge finds. Required whenever the grammar
     * is on. For `.solid.mx`, pass `compileSolidMx` from `@mxlang/solid`.
     */
    mxRegionCompile?: MxRegionCompile;
    /**
     * Makes `<>…</>` in expression position an MX fragment region whose
     * children the host lowers as siblings. Default `false` (`<>` stays a TSX
     * fragment, which `.solid.mx` wants). `@mxlang/angular` enables it for
     * `.ng.mx`. See `ParserOptions.mxRegionFragment`.
     */
    mxRegionFragment?: boolean;
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
