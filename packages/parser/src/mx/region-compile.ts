/**
 * Host-agnostic lowering hook for an MX region.
 *
 * The bridge discovers a region and hands its text to a *host* to lower. Which
 * host that is used to be settled at this module's import site: `bridge.ts`
 * imported `compileSolidMx` and called it for every region in every file. That
 * is correct for `.solid.mx` and unusable for any other file kind — Angular's
 * `.ng.mx` lowers the same region to an entirely different output (a template
 * string assigned to `@Component({ template: … })`, not JSX spliced into a TS
 * module).
 *
 * This is the same shape `MxRegionPositionCheck` already uses: a function on
 * the options bag, supplied by whoever is driving the parse, with the parser
 * itself staying free of host knowledge. The position check vetoes *where* a
 * region may appear; this decides *who lowers it*. Neither one teaches
 * `packages/parser` what a `Component` or a `template` is.
 */

import type { HoistedImport } from "./hoist-imports.ts";
import type { MxRegionContext } from "./region-context.ts";

/**
 * One synthesized import a region needs in its surrounding module.
 *
 * The same shape `hoist-imports.ts` places and `@mxlang/solid` returns —
 * re-exported rather than re-declared, so the three cannot drift into three
 * subtly different contracts for one object.
 */
export type { HoistedImport as MxRegionHoistedImport } from "./hoist-imports.ts";

/** The region text and its file-relative position, as the bridge found it. */
export interface MxRegionCompileInput {
  /** The region's own source text, `source.slice(start, end)`. */
  source: string;
  /**
   * The file being parsed, from `sourceFilename`. A host uses it for
   * diagnostics and for resolving a discovered tag's relative specifier.
   */
  filename: string;
  /** The region's absolute start offset in the file. */
  baseOffset: number;
  /** The region's 0-based start line in the file. */
  baseLine: number;
  /** The region's 0-based start column on that line. */
  baseColumn: number;
  /**
   * Custom tag definitions the caller registered, opaque here. The bridge
   * runs inside the tokenizer, so the options bag is the only channel an
   * integration has to the region being lowered.
   */
  // biome-ignore lint/suspicious/noExplicitAny: `@mxlang/core`'s CustomTag would be a cycle
  customTags?: Record<string, any>;
  /**
   * Where this region appeared, the same context `mxRegionPositionCheck`
   * was given (C3). Handed over so a host that needs the enclosing syntax
   * *downstream* — to shape what it emits, not merely to accept or reject
   * the position — does not need a side channel back into the parser.
   *
   * Undefined when no `mxRegionPositionCheck` is set, because the parent-frame
   * stack it is computed from is only tracked when a host asked for it.
   */
  context?: MxRegionContext;
}

/**
 * What the bridge needs back from a host.
 *
 * Deliberately narrower than any one host's own result type: this is exactly
 * the three fields `mxParseElementAt` consumes (`code` to re-parse,
 * `hoistedImports` and `returnVars` to stamp onto the region root). A host
 * returning more — a source map, expression mappings, warnings, the tags a
 * template used — keeps those on its own richer return type and hands its
 * caller the extra fields directly; the parser has no use for them and must
 * not grow a dependency on their shape.
 */
export interface MxRegionCompileResult {
  /** The lowered region, as source text the surrounding grammar can parse. */
  code: string;
  /**
   * Imports the compiler minted for discovered tags called inside this
   * region. A region is an expression and cannot hold an import itself, so
   * the surrounding module is the only place these can go.
   */
  hoistedImports?: HoistedImport[];
  /**
   * `/var` names this region's call sites bind, for the caller to declare —
   * a region has no statement position for the `let` a `/var` needs.
   */
  returnVars?: string[];
}

/**
 * Lowers one MX region to text the surrounding grammar can parse.
 *
 * ## Throwing: coordinates must be file-absolute
 *
 * A hook that throws a **positioned** error — one carrying `line`/`column`,
 * as `@mxlang/core`'s `TranslateError` does — must give them **relative to
 * the whole file**, not to the region: `line` 1-based, `column` 0-based. The
 * bridge trusts those coordinates as-is and does not shift them by the
 * region's own `baseLine`/`baseColumn`, so a host reporting region-relative
 * coordinates lands every diagnostic on line 1.
 *
 * Apply the offsets yourself, exactly as `compileSolidMx` does: it pads its
 * source with `baseLine` newlines before lowering, so every position the core
 * computes is already file-absolute. The `baseLine`/`baseColumn` on
 * `MxRegionCompileInput` are what you need for this.
 *
 * A hook that throws anything else — a plain `Error`, or a non-`Error` value
 * — is reported at the **region's own start**, with its message preserved.
 * That is a deliberate floor rather than a guess: a plain `Error`'s `line`
 * property is V8's *throw site* inside the host's own module, which would
 * otherwise be read as a position in the user's `.mx` file.
 */
export type MxRegionCompile = (
  input: MxRegionCompileInput,
) => MxRegionCompileResult;
