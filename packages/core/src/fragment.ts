/**
 * The fragment front door (decision 70): parse a *substring* of a larger file
 * as Marko, with positions reported against the enclosing file.
 *
 * The consumer is a host whose MX lives inside another language — the Solid host's
 * `.solid.mx`, where an MX region starts partway into a TSX file. Marko's
 * parser has no base-position parameter, so every `loc` it produces is
 * relative to the substring it was given. This shifts them afterwards.
 *
 * It is the stopgap `notes/research/marko-seam-spikes.md` (spike 1) measured,
 * not a fix: the fix is an additive `parseFragment({ start, line, column })`
 * upstream, which MX still intends to send once a host consumes this door.
 * The Solid host's own bridge (`packages/tsx-bridge/src/mx/bridge.ts`) is untouched
 * until phase 4 switches it over.
 *
 * ## Documented limits (all measured, spike 1)
 *
 * - **Marko's own nodes carry no numeric offsets at all.** `MarkoTag`,
 *   `MarkoAttribute`, `MarkoTagBody`, `MarkoComment`, `MarkoPlaceholder` and
 *   the tag-name `StringLiteral` have `start`/`end` `undefined`; only
 *   `loc.start`/`loc.end` (`{ line, column }`) are populated. There is
 *   nothing to shift there, and nothing this function can invent.
 * - **Nested expression nodes carry their index inside `loc`.** A Babel
 *   expression under a Marko node (an attribute's value, an identifier) has
 *   `loc.start.index`/`loc.end.index` but no top-level `start`/`end`. Both
 *   shapes are shifted here — the `index` one explicitly, because the naive
 *   spike walk missed it and left indexes substring-relative while the
 *   line/column half was file-relative: an internally inconsistent node.
 * - **A thrown parse error's position lives on the exception**, not in a
 *   tree, so no walk can reach it. `parseFragment` catches, shifts `err.loc`
 *   and rethrows the same error object.
 * - **Comments**: Marko does not populate Babel's file-level `comments`
 *   array; `MarkoComment` nodes in the body are shifted like any other node.
 */

import { dirname } from "node:path";
import { rejectShadowedRegistration } from "./builtin-tags.ts";
import { type Node, TranslateError } from "./core.ts";
import { STATEMENT_TAGLIB, STATEMENT_TAGLIB_ID } from "./core-taglib.ts";
import {
  type CustomTag,
  customTagTaglib,
  rejectUnknownDeclarationKeys,
  rejectUnreachableHooks,
  rejectWildcardReferences,
} from "./custom-tags.ts";
import { nullPrototypeTags } from "./lookup-safety.ts";
import { markoCompiler } from "./marko-frontend.ts";
import { shorthandDiagnosticError } from "./shorthand-diagnostics.ts";
import {
  bareCommaError,
  stockAtomError,
  stockParserError,
  sugarAfterDefaultError,
  tagParamError,
} from "./stock-parser.ts";

/**
 * A translator that translates nothing: the parse-only configuration.
 *
 * `@marko/compiler` requires *a* translator and resolves `marko/translator`
 * when none is given. This one registers no taglibs beyond Marko's own
 * built-ins and core's (decision 168: the statement tags are the language's,
 * so every parse knows them) and no `translate` visitors, so `compileSync`
 * parses and stops.
 */
const STATEMENT_ENTRY: [string, unknown] = [
  STATEMENT_TAGLIB_ID,
  STATEMENT_TAGLIB,
];

const PARSE_ONLY_TRANSLATOR = {
  taglibs: [STATEMENT_ENTRY],
  tagDiscoveryDirs: [],
  translate: {},
};

/**
 * Builds the lookup `compileSync` is about to ask for (Marko caches it by
 * taglib ids), and makes its tag map prototype-free so a tag named `toString` is an
 * ordinary unknown tag rather than a crash (see `lookup-safety.ts`).
 */
function prepareLookup(
  // biome-ignore lint/suspicious/noExplicitAny: the compiler is required untyped here
  compiler: any,
  filename: string,
  translator: unknown,
): void {
  nullPrototypeTags(compiler.taglib.buildLookup(dirname(filename), translator));
}

function parseOnlyTranslator(
  customTags: Record<string, CustomTag> | undefined,
) {
  rejectShadowedRegistration(customTags);
  rejectUnknownDeclarationKeys(customTags);
  rejectWildcardReferences(customTags);
  rejectUnreachableHooks(customTags);
  const taglib = customTagTaglib(customTags);
  return taglib
    ? { ...PARSE_ONLY_TRANSLATOR, taglibs: [STATEMENT_ENTRY, taglib] }
    : PARSE_ONLY_TRANSLATOR;
}

/**
 * The base position of a fragment, and the contract a host keeps with it.
 *
 * ## The padding contract
 *
 * `parseFragment` only ever sees the fragment, never the file, so it cannot
 * check the host's side of this contract — it checks what it can see, the
 * numbers (see `assertBaseContract`). The host's side is this: a host that
 * also reads *the same positions* through a padded copy of the file (its
 * `Ctx` source — `sliceLoc`'s `lines[line]`, `offsetOf`'s
 * `(line - 1) + column` walk, `expr()`'s index slice) must build that copy as
 *
 * 1. `baseOffset - baseLine - baseColumn` filler characters, then
 * 2. exactly `baseLine` newlines, then
 * 3. exactly `baseColumn` characters on the fragment's own line, then
 * 4. the fragment.
 *
 * Why: Marko reports most nodes as `{ line, column }` only, with no index.
 * Such a position is shifted by `baseLine` lines and, on the fragment's first
 * line only, by `baseColumn`; an index is shifted by `baseOffset`. The two
 * systems then agree with the file only if the filler sits *before* the
 * newlines (inert to line/column readers) and the fragment's line carries
 * exactly `baseColumn` characters. Padding the fragment's line out to
 * `baseOffset - baseLine` instead overshoots `baseColumn` whenever anything
 * precedes the fragment on an earlier line, and every first-line attribute
 * name then resolves into unrelated text.
 *
 * Conventions (what each number counts): all are UTF-16 code units, the unit
 * of a JS string index and of Babel/Marko columns. `baseLine` is zero-based
 * (the count of `\n` before the fragment; Marko's own lines are one-based and
 * shifted by it). `baseColumn` is zero-based: the units between the last `\n`
 * before the fragment (or the file start) and the fragment's first unit.
 * `baseOffset` is the unit count of everything before the fragment.
 *
 * Invariants on the numbers:
 *
 * - each is a finite integer;
 * - `baseLine >= 0`;
 * - when `baseOffset` is given and `baseLine` is 0, `baseOffset === baseColumn`:
 *   the fragment is on the file's first line, so everything before it is that
 *   line's first `baseColumn` units. A larger offset would put filler on the
 *   fragment's own line and shift every first-line column (measured:
 *   `{ baseOffset: 24, baseLine: 0, baseColumn: 19 }` read `<div ` where the
 *   attribute name `class` was);
 * - when `baseOffset` is given and `baseLine >= 1`, `baseOffset >= baseLine +
 *   baseColumn`. Proof: the `baseOffset` units before the fragment contain
 *   `baseLine` newline units, and the last line holds `baseColumn` further
 *   units that are not newlines; the two sets are disjoint. Earlier lines may
 *   hold any number of units, so nothing tighter than `>=` is knowable from
 *   the numbers; equality is a file of empty lines followed by the fragment,
 *   and `\r\n` endings only raise `baseOffset`. This is what makes the filler
 *   count in rule 1 non-negative; a host that clamps it (`Math.max(…, 0)`)
 *   hides a violation and mis-maps silently.
 *
 * `baseOffset` and `baseColumn` may be negative together: a host that wraps
 * the fragment in extra text (angular's `<>` wrapper) subtracts the wrapper's
 * length from both, and both invariants still hold. `parseFragment` cannot
 * tell such a pair from a lone bad value when `baseLine >= 1` (the wrapper's
 * length is unknown to it), so it only rejects a negative `baseColumn` that
 * has no `baseOffset` partner; `positionRegionSource` sees the pre-wrapper
 * position and requires both to be non-negative. A violation throws a
 * `TranslateError` positioned at the fragment's start.
 */
export interface FragmentBase {
  /** The name reported for the *enclosing* file, in diagnostics. */
  filename?: string;
  /**
   * Character offset of the fragment's first character within the file. When
   * omitted, indexes stay fragment-relative and the offset checks
   * (`===` on line 0, `>=` after) are skipped.
   */
  baseOffset?: number;
  /**
   * Zero-based line offset: the number of newlines before the fragment. Added
   * to Marko's one-based lines, so a fragment starting on file line 6 passes
   * 5.
   */
  baseLine?: number;
  /**
   * Column of the fragment's first character. Applied only to positions on
   * the fragment's own first line — a later line starts at its own column 0
   * in both the fragment and the file.
   */
  baseColumn?: number;
  /** Registered custom tags whose parse options affect this fragment. */
  customTags?: Record<string, CustomTag>;
}

type ResolvedFragmentBase = Required<Omit<FragmentBase, "customTags">>;

export interface FragmentResult {
  /** The parsed program's body: the fragment's top-level nodes. */
  body: Node[];
  /** The whole `File` node, for a caller that wants the program itself. */
  ast: Node;
}

/** A parse error with a file-relative `loc`, as thrown by `parseFragment`. */
interface PositionedError extends Error {
  loc?: {
    start?: { line: number; column: number; index?: number };
    end?: { line: number; column: number; index?: number };
  };
}

function shiftPosition(
  position: Node,
  base: ResolvedFragmentBase,
  seen?: Set<object>,
): void {
  if (!position || typeof position !== "object") return;
  // Position objects are *shared* between nodes in Marko's tree — an
  // attribute's `loc.start` is the same object as its value expression's, so
  // the walk reaches it more than once and a second shift lands at
  // `base + base`. Measured: `href=input.url` at raw index 16 with
  // `baseOffset: 42` came out at 100 instead of 58. Deduping whole nodes is
  // not enough; the positions themselves have to be tracked.
  if (seen) {
    if (seen.has(position)) return;
    seen.add(position);
  }
  // Column shifts only on the fragment's first line: every later line begins
  // at its own column 0 in the file as well as in the fragment.
  if (position.line === 1 && typeof position.column === "number") {
    position.column += base.baseColumn;
  }
  if (typeof position.line === "number") position.line += base.baseLine;
  if (typeof position.index === "number") position.index += base.baseOffset;
}

/**
 * Deep-walks a tree, shifting every position it carries.
 *
 * `seen` is load-bearing, not defensive: Marko's tree is a graph, not a tree —
 * an attribute's value node is reachable both as `attributes[i].value` and
 * through the tag's own fields, and a node shifted twice lands at
 * `base + base`. Measured: `href=input.url` at raw index 16 with
 * `baseOffset: 42` came out at 100 instead of 58 before this set existed.
 */
function shiftNode(
  node: Node,
  base: ResolvedFragmentBase,
  seen: Set<object> = new Set(),
): void {
  if (!node || typeof node !== "object") return;
  if (typeof node.line === "number" && typeof node.column === "number") {
    shiftPosition(node, base, seen);
    return;
  }
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) shiftNode(item, base, seen);
    return;
  }

  // Babel parse failures embedded in an otherwise valid Marko tree carry
  // their precise location under a plain `errorLoc` object. It has no node
  // `type`, so stopping at untyped containers leaves that position relative
  // to the fragment while every surrounding node is file-relative.
  if (node.loc) {
    shiftPosition(node.loc.start, base, seen);
    shiftPosition(node.loc.end, base, seen);
  }
  // Present on plain Babel nodes only; absent on Marko's own.
  if (typeof node.type === "string") {
    if (typeof node.start === "number") node.start += base.baseOffset;
    if (typeof node.end === "number") node.end += base.baseOffset;
  }

  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "extra") continue;
    shiftNode(node[key], base, seen);
  }
}

/**
 * Throws, positioned at the fragment's start, when `base` breaks the numeric
 * half of the padding contract documented on `FragmentBase`. O(1): the padded
 * prefix is the host's, and never reaches this function.
 */
function assertBaseContract(base: FragmentBase, filename: string): void {
  const line = (base.baseLine ?? 0) + 1;
  const column = base.baseColumn ?? 0;
  const fail = (rule: string): never => {
    throw new TranslateError(
      `parseFragment: broken padding contract in ${filename} at line ${Math.max(1, line)}, column ${Math.max(1, column + 1)}: ${rule} ` +
        `(baseOffset: ${base.baseOffset}, baseLine: ${base.baseLine}, baseColumn: ${base.baseColumn})`,
      line,
      column,
      filename,
    );
  };
  for (const name of ["baseOffset", "baseLine", "baseColumn"] as const) {
    const value = base[name];
    if (value !== undefined && !Number.isInteger(value)) {
      fail(`${name} must be a finite integer`);
    }
  }
  if (base.baseLine !== undefined && base.baseLine < 0) {
    fail("baseLine must be >= 0");
  }
  const { baseOffset, baseColumn = 0 } = base;
  const baseLine = base.baseLine ?? 0;
  if (baseOffset === undefined) {
    if (baseColumn < 0) {
      fail("a negative baseColumn needs its baseOffset partner");
    }
    return;
  }
  if (baseLine === 0) {
    if (baseOffset !== baseColumn) {
      fail(
        "baseOffset must equal baseColumn when baseLine is 0 (the fragment is on the file's first line)",
      );
    }
  } else if (baseOffset < baseLine + baseColumn) {
    fail(
      "baseOffset must be >= baseLine + baseColumn (the padded prefix would need a negative filler)",
    );
  }
}

/** A region's position in its file, in the units `FragmentBase` documents. */
export interface RegionPosition {
  baseOffset: number;
  baseLine: number;
  baseColumn: number;
}

export interface PositionedRegion {
  /**
   * The text a host builds its `Ctx` over: the region behind a prefix that
   * makes line/column readers and index readers agree with the file (rules
   * 1–4 on `FragmentBase`).
   */
  padded: string;
  /** What to pass to `parseFragment`, matching `padded` by construction. */
  base: Required<Pick<FragmentBase, "baseOffset" | "baseLine" | "baseColumn">>;
}

/**
 * Builds a region's padded `Ctx` source *and* the `parseFragment` base that
 * goes with it, so the two cannot diverge — the pad is the host's half of the
 * contract `FragmentBase` documents, and `parseFragment` cannot see it.
 *
 * `at` is where the region's first character sits in the file. Throws the
 * contract's positioned `TranslateError` when `at` violates its invariants,
 * rather than clamping the filler.
 *
 * `wrapper` is the length of text the host puts *in front of the region inside
 * the string it parses* (angular's `<${0}>` around a `<>…</>` fragment's
 * children). It sits on the parsed first line, so `base` is `at` minus
 * `wrapper` in offset and column, while `padded` still describes the file —
 * without the wrapper. Those two may only differ by construction.
 *
 * O(prefix length): one string of `baseOffset + region.length` units.
 */
export function positionRegionSource(
  region: string,
  at: RegionPosition,
  options: { wrapper?: number; filename?: string } = {},
): PositionedRegion {
  const filename = options.filename ?? "fragment.mx";
  assertBaseContract(at, filename);
  // The pre-wrapper position is a real file position: neither can be negative.
  // (Only the wrapper-compensated `base` below may be.)
  if (at.baseOffset < 0 || at.baseColumn < 0) {
    throw new TranslateError(
      `parseFragment: broken padding contract in ${filename} at line ${
        at.baseLine + 1
      }, column ${Math.max(1, at.baseColumn + 1)}: baseOffset and baseColumn must be >= 0 before any wrapper is subtracted ` +
        `(baseOffset: ${at.baseOffset}, baseLine: ${at.baseLine}, baseColumn: ${at.baseColumn})`,
      at.baseLine + 1,
      at.baseColumn,
      filename,
    );
  }
  const wrapper = options.wrapper ?? 0;
  const leadingFill = at.baseOffset - at.baseLine - at.baseColumn;
  return {
    padded: `${" ".repeat(leadingFill)}${"\n".repeat(at.baseLine)}${" ".repeat(
      at.baseColumn,
    )}${region}`,
    base: {
      baseOffset: at.baseOffset - wrapper,
      baseLine: at.baseLine,
      baseColumn: at.baseColumn - wrapper,
    },
  };
}

/**
 * Parses `source` as a Marko fragment, with every position shifted by `base`.
 *
 * Uses `@marko/compiler`'s own parser (`output: "source"`, `ast: true`), so
 * the nodes are the same `MarkoTag`/`MarkoAttribute` shapes the core's
 * emitters consume — ADR 0001's point: one parse layer, no second grammar.
 */
export function parseFragment(
  source: string,
  base: FragmentBase = {},
): FragmentResult {
  assertBaseContract(base, base.filename ?? "fragment.mx");
  const resolved: ResolvedFragmentBase = {
    filename: base.filename ?? "fragment.mx",
    baseOffset: base.baseOffset ?? 0,
    baseLine: base.baseLine ?? 0,
    baseColumn: base.baseColumn ?? 0,
  };

  const compiler = markoCompiler();
  const translator = parseOnlyTranslator(base.customTags);
  prepareLookup(compiler, resolved.filename, translator);
  // Decision 174: the shorthand diagnostics are source-relative here, so they
  // are shifted like every other position the fragment reports.
  const shorthand = shorthandDiagnosticError(source);
  if (shorthand) {
    const at = { line: shorthand.line, column: shorthand.column };
    shiftPosition(at, resolved);
    throw new TranslateError(shorthand.message, at.line, at.column);
  }
  let ast: Node;
  try {
    ast = compiler.compileSync(source, resolved.filename, {
      output: "source",
      ast: true,
      // A translator with an empty `translate` is what makes this parse-only.
      // Without one, `@marko/compiler` resolves its *default* translator
      // (`marko/translator`, from the `marko` package) before it parses, which
      // a package that only wants the AST has no reason to depend on — and
      // `@mxlang/core` does not.
      translator,
      // biome-ignore lint/suspicious/noExplicitAny: the compiler's result type is untyped here
    } as any).ast;
  } catch (thrown) {
    const error = markoPrintCrash(thrown)
      ? (reparseForError(compiler, source, resolved.filename, translator) ?? thrown)
      : thrown;
    // A thrown error's position is on the exception, never in a tree, so the
    // walk below can never reach it (spike 1, limit 2).
    const positioned = error as PositionedError;
    // Decision 151: a stock htmljs-parser cannot read `:name` after a value.
    // The fragment's own coordinates are shifted like Marko's error's.
    const stock =
      bareCommaError(error, source) ??
      tagParamError(error, source) ??
      sugarAfterDefaultError(error, source) ??
      stockParserError(error, source) ??
      stockAtomError(error, source);
    if (stock) {
      const at = { line: stock.line, column: stock.column };
      shiftPosition(at, resolved);
      throw new TranslateError(stock.message, at.line, at.column);
    }
    if (positioned?.loc) {
      shiftPosition(positioned.loc.start, resolved);
      // Marko's `CompileError` for a point error shares one object between
      // `start` and `end`; shifting it twice would land at `base + base`.
      if (positioned.loc.end !== positioned.loc.start) {
        shiftPosition(positioned.loc.end, resolved);
      }
    }
    throw error;
  }

  shiftNode(ast, resolved);
  return { ast, body: ast.program?.body ?? [] };
}

/**
 * Marko's `source` output prints the tree it parsed, and a tag it failed to
 * parse part of (a method's type parameters that are not a type-parameter list,
 * `x<A<B>>(a) {b}`) leaves a bare array where the printer expects a node, so
 * the print throws `unknown node of type undefined with constructor "Array"`
 * before Marko reports the positioned parse error it recorded.
 */
function markoPrintCrash(error: unknown): boolean {
  return (
    error instanceof ReferenceError &&
    /unknown node of type undefined with constructor "Array"/.test(
      error.message,
    )
  );
}

/**
 * Asks Marko to compile again to a form that reports its recorded parse errors
 * before printing anything, and returns what it throws (its own positioned
 * `CompileError`), or `original` when that compile does not fail.
 */
function reparseForError(
  // biome-ignore lint/suspicious/noExplicitAny: the compiler is required untyped here
  compiler: any,
  source: string,
  filename: string,
  translator: unknown,
): Error | undefined {
  try {
    compiler.compileSync(source, filename, { translator, output: "html" });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return undefined;
}

/**
 * `parseFragment` implemented on the upstream offset API
 * (`docs/upstream/htmljs-parser-offset.patch` +
 * `docs/upstream/marko-compiler-offset.patch`) instead of the post-hoc shift
 * above: `@marko/compiler`'s `htmlParseOptions.{startOffset,startLine,
 * startColumn}` produces already-file-relative positions directly, so there
 * is no tree walk and no `seen` set here.
 *
 * Not used by any consumer — `docs/upstream/README.md` is the proof that it
 * produces identical results to `parseFragment` for every case the shifted
 * version is tested against. Exists only until the two patches land upstream
 * (or are decided against); at that point this becomes `parseFragment` and
 * the shifting implementation above is deleted.
 */
export function parseFragmentNative(
  source: string,
  base: FragmentBase = {},
): FragmentResult {
  const filename = base.filename ?? "fragment.mx";
  assertBaseContract(base, filename);
  const compiler = markoCompiler();
  const translator = parseOnlyTranslator(base.customTags);
  prepareLookup(compiler, filename, translator);
  const ast: Node = compiler.compileSync(source, filename, {
    output: "source",
    ast: true,
    translator,
    htmlParseOptions: {
      startOffset: base.baseOffset ?? 0,
      startLine: base.baseLine ?? 0,
      startColumn: base.baseColumn ?? 0,
    },
    // biome-ignore lint/suspicious/noExplicitAny: the compiler's result type is untyped here
  } as any).ast;

  return { ast, body: ast.program?.body ?? [] };
}
