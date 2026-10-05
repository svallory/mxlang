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

import type { HoistedDefine, HoistedImport } from "./hoist-imports.ts";
import type { MxRegionContext } from "./region-context.ts";

/**
 * One synthesized import a region needs in its surrounding module.
 *
 * The same shape `hoist-imports.ts` places and `@mxlang/solid` returns —
 * re-exported rather than re-declared, so the three cannot drift into three
 * subtly different contracts for one object.
 */
/**
 * One `<define>` a region hoisted to module scope (decision 110b).
 *
 * Re-exported for the same reason `MxRegionHoistedImport` is: one contract
 * shared by `hoist-imports.ts`, this module, and `@mxlang/solid`.
 */
export type {
  HoistedDefine as MxRegionHoistedDefine,
  HoistedImport as MxRegionHoistedImport,
} from "./hoist-imports.ts";

/** The region text and its file-relative position, as the bridge found it. */
export interface MxRegionCompileInput {
  /** The region's own source text, `source.slice(start, end)`. */
  source: string;
  /**
   * The file being parsed, from `sourceFilename`. A host uses it for
   * diagnostics and for resolving a discovered tag's relative specifier.
   */
  filename: string;
  /**
   * True for a fragment region (`<>…</>`, `mxRegionFragment`). Then `source`
   * is the fragment's children only, `baseOffset`/`baseColumn` locate the
   * first of them, and the region the bridge replaces spans `source` plus the
   * two characters of `<>` before it and the three of `</>` after it — so a
   * host that splices text back into the file by offset must widen its span.
   * Absent or false for every ordinary region.
   */
  fragment?: boolean;
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
  /** `package.json#mx.<target>.defaultTag` the caller resolved (decision 145). */
  defaultTag?: string;
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
  /** Imports declared by the surrounding module, local binding -> specifier. */
  importSpecifiers: ReadonlyMap<string, string>;
  /**
   * Every value the surrounding module binds at its top level — import
   * locals plus top-level `const`/`function`/`class` names, type-only
   * bindings excluded (`@mxlang/parser`'s `programBindings`). A capitalized
   * tag a region references may resolve through this scope rather than
   * anything the region itself imports or declares (decision 114).
   */
  moduleBindings: ReadonlySet<string>;
  /**
   * The subset of `importSpecifiers`' bindings that are a *default* import
   * from a `.marko`/`.mx` source — Marko's own statically-resolved
   * component case (decision 116; `@mxlang/core`'s `isMarkoOrMxSpecifier`).
   * A host lowers a capitalized tag bound to a name in this set as a direct
   * component call, exactly as before decision 116; any other value import
   * (named, namespace, or a default from any other extension) lowers as a
   * dynamic tag instead, matching Marko's own `_dynamic_tag` runtime
   * dispatch. Not itself filtered by anything `importSpecifiers` isn't —
   * every name here is already a member of `importSpecifiers`.
   */
  importDefaultFromMarkoOrMx: ReadonlySet<string>;
  /**
   * The subset of `moduleBindings`' *non-import* names (a top-level
   * `const`/`function`/`class`) whose value is not statically a
   * function/arrow/class — the local extension of decision 116 (firstmate's
   * ruling under decision 116 in `notes/decisions-2026-09-10.md`;
   * `@mxlang/parser`'s `unknownProgramBindings`). A host lowers a
   * capitalized tag bound to a name in this set as a dynamic tag instead of
   * the direct call `moduleBindings` alone would give it.
   */
  unknownModuleBindings: ReadonlySet<string>;
}

/**
 * What the bridge needs back from a host.
 *
 * Deliberately narrower than any one host's own result type: this is exactly
 * the fields `mxParseElementAt` consumes (`code` to re-parse, `hoistedImports`,
 * `hoistedDefines` and `returnVars` to stamp onto the region root). A host
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
   * `<define>`s the region hoisted to module scope (decision 110b). A region
   * is an expression, so it cannot hold a function declaration either — same
   * reason `hoistedImports` exists, for an author's own construct instead of
   * a discovered tag's synthesized import.
   */
  hoistedDefines?: HoistedDefine[];
  /**
   * `/var` names this region's call sites bind, for the caller to declare —
   * a region has no statement position for the `let` a `/var` needs.
   */
  returnVars?: string[];
  /** Files read while resolving callees used by this region. */
  dependencies?: string[];
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
