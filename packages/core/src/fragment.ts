/**
 * The fragment front door (decision 70): parse a *substring* of a larger file
 * as Marko, with positions reported against the enclosing file.
 *
 * The consumer is a host whose MX lives inside another language — SolidMX's
 * `.solid.mx`, where an MX region starts partway into a TSX file. Marko's
 * parser has no base-position parameter, so every `loc` it produces is
 * relative to the substring it was given. This shifts them afterwards.
 *
 * It is the stopgap `notes/research/marko-seam-spikes.md` (spike 1) measured,
 * not a fix: the fix is an additive `parseFragment({ start, line, column })`
 * upstream, which MX still intends to send once a host consumes this door.
 * SolidMX's own bridge (`packages/parser/src/mx/bridge.ts`) is untouched
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

import { createRequire } from "node:module";
import { rejectShadowedRegistration } from "./builtin-tags.ts";
import type { Node } from "./core.ts";
import {
  type CustomTag,
  customTagTaglib,
  rejectUnknownDeclarationKeys,
  rejectUnreachableHooks,
} from "./custom-tags.ts";

const require = createRequire(import.meta.url);

/**
 * A translator that translates nothing: the parse-only configuration.
 *
 * `@marko/compiler` requires *a* translator and resolves `marko/translator`
 * when none is given. This one registers no taglibs beyond Marko's own
 * built-ins and no `translate` visitors, so `compileSync` parses and stops.
 */
const PARSE_ONLY_TRANSLATOR = {
  taglibs: [],
  tagDiscoveryDirs: [],
  translate: {},
};

function parseOnlyTranslator(
  customTags: Record<string, CustomTag> | undefined,
) {
  rejectShadowedRegistration(customTags);
  rejectUnknownDeclarationKeys(customTags);
  rejectUnreachableHooks(customTags);
  const taglib = customTagTaglib(customTags);
  return taglib
    ? { ...PARSE_ONLY_TRANSLATOR, taglibs: [taglib] }
    : PARSE_ONLY_TRANSLATOR;
}

export interface FragmentBase {
  /** The name reported for the *enclosing* file, in diagnostics. */
  filename?: string;
  /** Character offset of the fragment's first character within the file. */
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
  const resolved: ResolvedFragmentBase = {
    filename: base.filename ?? "fragment.mx",
    baseOffset: base.baseOffset ?? 0,
    baseLine: base.baseLine ?? 0,
    baseColumn: base.baseColumn ?? 0,
  };

  const compiler = require("@marko/compiler");
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
      translator: parseOnlyTranslator(base.customTags),
      // biome-ignore lint/suspicious/noExplicitAny: the compiler's result type is untyped here
    } as any).ast;
  } catch (error) {
    // A thrown error's position is on the exception, never in a tree, so the
    // walk below can never reach it (spike 1, limit 2).
    const positioned = error as PositionedError;
    if (positioned?.loc) {
      shiftPosition(positioned.loc.start, resolved);
      shiftPosition(positioned.loc.end, resolved);
    }
    throw error;
  }

  shiftNode(ast, resolved);
  return { ast, body: ast.program?.body ?? [] };
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
  const compiler = require("@marko/compiler");
  const ast: Node = compiler.compileSync(source, filename, {
    output: "source",
    ast: true,
    translator: parseOnlyTranslator(base.customTags),
    htmlParseOptions: {
      startOffset: base.baseOffset ?? 0,
      startLine: base.baseLine ?? 0,
      startColumn: base.baseColumn ?? 0,
    },
    // biome-ignore lint/suspicious/noExplicitAny: the compiler's result type is untyped here
  } as any).ast;

  return { ast, body: ast.program?.body ?? [] };
}
