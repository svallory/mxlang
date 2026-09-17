import { compileSolidMx, type HoistedImport } from "@mxlang/solid";
import { parseExpression } from "../babel/index.ts";
import { types as tc } from "../babel/tokenizer/context.ts";
import { Position } from "../babel/util/location.ts";
import { MxErrors } from "./errors.ts";
import type { MxRegionCompile } from "./region-compile.ts";
import {
  computeMxRegionContext,
  type MxRegionContext,
  type MxRegionPositionCheck,
} from "./region-context.ts";
import { type MxElement, type MxRange, walkMxRegion } from "./walk.ts";

/**
 * The parser surface `mxParseElementAt` needs. Structural rather than a direct
 * import of the Parser class, so this module stays free of the vendored
 * parser's mixin plumbing.
 */
export interface MxParserHost {
  input: string;
  state: {
    pos: number;
    curLine: number;
    lineStart: number;
    startIndex: number;
    context: unknown[];
    start: number;
    startLoc: Position;
    end: number;
    endLoc: Position;
    // biome-ignore lint/suspicious/noExplicitAny: MxRegionParentFrame kept structural, to avoid a tokenizer-state dependency cycle
    mxRegionParents: any[];
  };
  // biome-ignore lint/suspicious/noExplicitAny: matches the vendored raise signature
  raise(toParseError: any, at: Position | any, details?: any): unknown;
  next(): void;
  // biome-ignore lint/suspicious/noExplicitAny: the vendored options bag
  options: any;
  // biome-ignore lint/suspicious/noExplicitAny: Babel's own node type is internal
  finishNode?: any;
}

/**
 * Parses one MX element starting at `startLoc` and leaves the tokenizer sitting
 * on the first token after the root tag closes.
 *
 * Called in place of `jsxParseElementAt`, which means it runs *speculatively*:
 * the TypeScript plugin's `parseMaybeAssign` tries the JSX/MX grammar inside a
 * `tryParse` on every `<` in expression position, including ones that turn out
 * to be generic arrows (`<T,>(x: T) => x`). So every failure here has to go
 * through `raise` — `tryParse` decides an attempt failed by comparing
 * `state.errors.length`, and a raw exception from htmljs-parser would escape
 * that contract. Nothing thrown by htmljs-parser is allowed to leave this
 * function.
 */
export function mxParseElementAt(
  parser: MxParserHost,
  startLoc: Position,
): unknown {
  const source = parser.input;
  const start = startLoc.index - parser.state.startIndex;

  // Babel's own context stack must come out exactly as deep as it went in. The
  // JSX plugin pushed `j_oTag` before reaching here (entry depth is always the
  // caller's depth + 1); the MX walk never touches the stack, so truncating
  // back to the entry depth minus that one push is enough.
  const contextDepth = parser.state.context.length - 1;

  const { root, end, errors } = walkMxRegion(source, start);

  if (errors.length > 0 || root === null) {
    const first = errors[0];
    const at = first
      ? positionAt(source, first.start, parser.state.startIndex)
      : startLoc;
    throw raiseAndThrow(parser, MxErrors.HtmlParserError, at, {
      message: first?.message ?? "Invalid MX element.",
    });
  }

  // A host's veto on where this region may appear, computed from the
  // parser's own syntactic state (region-context.ts) — no Angular (or any
  // other host) knowledge here. `startLoc` is used for the raise, same as
  // the walk-error fallback above: the offending thing is the region's
  // placement, so no inner offset is more informative.
  const positionCheck = parser.options?.mxRegionPositionCheck as
    | MxRegionPositionCheck
    | undefined;
  // Kept in scope past the check so the compile hook below can be handed the
  // same context, rather than a host having to re-derive it through a side
  // channel the parser does not offer.
  let regionContext: MxRegionContext | undefined;
  if (positionCheck) {
    const context = computeMxRegionContext(
      parser.state.mxRegionParents,
      startLoc.index,
    );
    regionContext = context;
    const result = positionCheck(context);
    if (!result.ok) {
      throw raiseAndThrow(parser, MxErrors.PositionRejected, startLoc, {
        message: result.message,
      });
    }
  }

  let node: unknown;
  try {
    const region = source.slice(start, end);
    // Which host lowers this region is the caller's to decide, on the same
    // options-bag channel `mxRegionPositionCheck` uses — the bridge runs
    // inside the tokenizer and has no other route to an integration. Absent,
    // it is the Solid host, exactly as every `.solid.mx` parse has always
    // done; `compileSolidMx`'s own option names are what this input mirrors.
    const regionCompile = parser.options?.mxRegionCompile as
      | MxRegionCompile
      | undefined;
    // One position/tag bag for both arms: the two used to repeat five
    // arguments, where a change to one could silently miss the other.
    const base = {
      baseOffset: start,
      baseLine: startLoc.line - 1,
      baseColumn: startLoc.column,
      // Registered custom tags reach a host only through here, for the same
      // reason the hook itself does.
      customTags: parser.options?.mxCustomTags,
    };
    const { code, hoistedImports, returnVars } = regionCompile
      ? regionCompile({
          source: region,
          filename: parser.options?.sourceFilename ?? "input.mx",
          // The region's syntactic position, already computed for the veto
          // above. Handed over so a host that needs it downstream — to shape
          // its emit, not merely to accept or reject — needs no side channel
          // back into the parser. Undefined when no position check ran, since
          // the stack is only tracked then.
          context: regionContext,
          ...base,
        })
      : compileSolidMx(region, {
          filename: parser.options?.sourceFilename ?? "input.solid.mx",
          ...base,
        });
    node = parseExpression(code, {
      ...mxSubParseOptions(parser.options),
      mx: false,
      startIndex: start,
      startLine: startLoc.line,
      startColumn: startLoc.column,
    });
    remapExpressionLocations(node, root, code, source, start, end);
    stampRoot(node, source, start, end, hoistedImports, returnVars);
  } catch (err) {
    const error = err as {
      message?: string;
      name?: string;
      line?: number;
      column?: number;
      reasonCode?: unknown;
      code?: unknown;
      loc?: { start?: { line?: number; column?: number; index?: number } };
    };
    const line = error.line ?? error.loc?.start?.line;
    const column = error.column ?? error.loc?.start?.column;
    // `line`/`column` are only believed when the thrower is recognizably
    // *positioned*: a Babel syntax error, or something carrying a real source
    // offset at `loc.start.index`. Every `Error` has a `line` in V8, and it
    // is the **throw site inside the throwing module** — measured: a host
    // throwing from its own line 11 for a region on line 3 reported (14:1)
    // in the user's `.mx` file, a position that exists in neither file.
    //
    // A positioned error's coordinates are trusted as file-absolute and are
    // *not* shifted by the region's base, because the one in-tree producer
    // (`compileSolidMx`) already pre-pads its source so the core computes
    // file-absolute positions. That contract is documented on
    // `MxRegionCompile` for every other host.
    //
    // The predicate must be **runtime-independent**, and this is the trap:
    // under Bun (JavaScriptCore), which is what this repo runs on, *every*
    // plain `Error` carries own numeric `line`/`column` naming its JS throw
    // site — measured: `Object.getOwnPropertyNames(new Error("x"))` includes
    // `line`, `column`, `originalLine`, `originalColumn`, `sourceURL`. V8
    // does not, so "an own line/column pair means someone set it
    // deliberately" holds on Node and fails here, sending a host's exception
    // to the host's own source line in the user's `.mx`.
    //
    // Each marker below is therefore a *deliberate* one, never a property a
    // runtime might add on its own: `TranslateError`'s name (the one shape
    // an in-tree host actually throws — it carries only `line`/`column`, no
    // `loc` and no `reasonCode`, measured against `@mxlang/core`'s class),
    // Babel's own error code / `reasonCode`, or a real source offset.
    const positioned =
      error.name === "TranslateError" ||
      error.code === "BABEL_PARSER_SYNTAX_ERROR" ||
      typeof error.reasonCode === "string" ||
      typeof error.loc?.start?.index === "number";
    if (positioned && typeof line === "number" && typeof column === "number") {
      const offset = offsetAt(source, line, column);
      throw raiseAndThrow(
        parser,
        MxErrors.HostError,
        positionAt(source, offset, parser.state.startIndex),
        { message: error.message ?? "Invalid MX element." },
      );
    }
    // Anything else — a plain `Error`, or a non-`Error` value a host threw —
    // is reported at the region's own start, the same fallback the walk-error
    // and position-check raises use. Rethrowing raw would escape the
    // positioned-`SyntaxError` contract `toSyntaxError` relies on, and would
    // break `tryParse`'s speculative-parse discipline for a non-`Error`.
    throw raiseAndThrow(parser, MxErrors.HostError, startLoc, {
      message:
        typeof error?.message === "string" && error.message
          ? error.message
          : String(err),
    });
  }

  repositionTokenizer(parser, source, start, end, contextDepth);
  return node;
}

interface ExpressionMapping {
  generatedStart: number;
  generatedEnd: number;
  sourceStart: number;
  sourceEnd: number;
}

/**
 * Restores the locations of TypeScript expressions copied through the Solid
 * emitter. The emitter necessarily inserts JSX punctuation (`title={` around
 * an MX dynamic attribute, `{() => {` around an attribute-method body), so
 * parsing its output shifts every descendant node even though the expression
 * text itself is unchanged.
 *
 * htmljs-parser already gave the bridge exact source ranges for those copied
 * expressions. Match those slices in the emitted region and move each Babel
 * descendant back to the matching source span.
 *
 * Nodes are handled in three cases, in order:
 *
 * 1. Inside a matched expression: shifted by that expression's delta. This is
 *    the case the column-accuracy tests pin — the expression text is identical
 *    in both coordinate systems, so the delta is exact.
 * 2. Outside the region entirely: clamped back into it. The emitter's
 *    scaffolding (`{() => {` around an attribute-method body) makes generated
 *    text longer than its source, so a late node's generated offset can run
 *    past the region's source end and claim a slice of the *following* code.
 *    That span is provably wrong, and left in place it becomes a source-map
 *    segment pointing at unrelated text — which a consumer's text-equality
 *    check then rejects, discarding the good neighbouring segments with it.
 * 3. Otherwise: left untouched. Structural nodes (the closing element, an
 *    attribute) already sit at their true source offsets, because the emitter
 *    reproduces the region's shape; overwriting them would lose spans the
 *    parser's own tests depend on.
 *
 * The generated text is untouched; only locations are repaired.
 */
function remapExpressionLocations(
  node: unknown,
  root: MxElement,
  generated: string,
  source: string,
  regionStart: number,
  regionEnd: number,
): void {
  const mappings = matchExpressionRanges(
    collectExpressionRanges(root),
    generated,
    source,
    regionStart,
  );

  const setSpan = (
    record: Record<string, unknown>,
    start: number,
    end: number,
  ) => {
    record.start = start;
    record.end = end;
    record.loc = { start: locAt(source, start), end: locAt(source, end) };
    if (Array.isArray(record.range)) record.range = [start, end];
  };

  const visit = (value: unknown) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const record = value as Record<string, unknown>;
    const generatedStart = record.start;
    const generatedEnd = record.end;
    if (
      typeof generatedStart === "number" &&
      typeof generatedEnd === "number"
    ) {
      // The most specific expression wholly containing this node wins: nested
      // expressions (an attribute body and a call inside it) both match, and
      // the inner one carries the correct delta for its own descendants.
      let best: ExpressionMapping | undefined;
      for (const candidate of mappings) {
        if (
          generatedStart < candidate.generatedStart ||
          generatedEnd > candidate.generatedEnd
        ) {
          continue;
        }
        if (
          best === undefined ||
          candidate.generatedEnd - candidate.generatedStart <
            best.generatedEnd - best.generatedStart
        ) {
          best = candidate;
        }
      }

      if (best) {
        const delta = best.sourceStart - best.generatedStart;
        setSpan(
          record,
          generatedStart + delta,
          Math.min(generatedEnd + delta, best.sourceEnd),
        );
      } else if (generatedStart > regionEnd || generatedEnd > regionEnd) {
        setSpan(
          record,
          Math.min(generatedStart, regionEnd),
          Math.min(generatedEnd, regionEnd),
        );
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== "loc" && key !== "extra") visit(child);
    }
  };

  visit(node);
}

/**
 * Locates each source expression inside the emitted region text.
 *
 * The emitter copies expression text verbatim, so a literal search finds it.
 * The search is anchored by a moving `cursor` so two identical expressions in
 * one region (`<p a=x b=x>`) map to their own occurrences in order rather than
 * both matching the first. Ranges are sorted by source position first, which
 * is the order the emitter writes them in.
 */
function matchExpressionRanges(
  ranges: MxRange[],
  generated: string,
  source: string,
  regionStart: number,
): ExpressionMapping[] {
  const mappings: ExpressionMapping[] = [];
  let cursor = 0;

  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const rawText = source.slice(range.start, range.end);
    if (rawText.length === 0) continue;

    // The walker's ranges include whitespace the emitter strips or moves
    // (`{ expr }` becomes `{expr;}`). Trim to the expression content, which
    // is what survives verbatim.
    const leadingWs = rawText.length - rawText.trimStart().length;
    const text = rawText.trim();
    if (text.length === 0) continue;

    const generatedStart = generated.indexOf(text, cursor);
    if (generatedStart === -1) continue;

    mappings.push({
      generatedStart: regionStart + generatedStart,
      generatedEnd: regionStart + generatedStart + text.length,
      sourceStart: range.start + leadingWs,
      sourceEnd: range.start + leadingWs + text.length,
    });
    cursor = generatedStart + text.length;
  }

  return mappings;
}

function collectExpressionRanges(root: MxElement): MxRange[] {
  const ranges: MxRange[] = [
    ...root.name.expressions,
    ...(root.params ? [root.params] : []),
    ...(root.tagArgs ? [root.tagArgs] : []),
    ...(root.tagVar ? [root.tagVar] : []),
  ];

  for (const attr of root.attrs) {
    if (attr.kind === "dynamic" || attr.kind === "bound") {
      ranges.push(attr.value);
    } else if (attr.kind === "method") {
      ranges.push(attr.params, attr.body);
    } else if (attr.kind === "spread") {
      ranges.push(attr.value);
    }
  }

  for (const child of root.children) {
    if (child.kind === "placeholder") ranges.push(child.value);
    else if (child.kind === "element") {
      ranges.push(...collectExpressionRanges(child.element));
    }
  }

  return ranges;
}

/** Keep the region root anchored to the source MX span for diagnostics. */
function stampRoot(
  node: unknown,
  source: string,
  start: number,
  end: number,
  hoistedImports: HoistedImport[] = [],
  returnVars: string[] = [],
): void {
  if (!node || typeof node !== "object") return;
  const root = node as Record<string, unknown>;
  root.start = start;
  root.end = end;
  root.loc = {
    start: locAt(source, start),
    end: locAt(source, end),
  };
  root.range = [start, end];
  root.extra = {
    ...(root.extra as object | undefined),
    // `hoistedImports` rides the region root rather than a parser-level
    // collector because this function runs *speculatively*: the TypeScript
    // plugin tries the MX grammar inside a `tryParse` on every `<` in
    // expression position, and an attempt that loses (a generic arrow, say)
    // throws its node away. A collector would keep that attempt's imports;
    // a stamp on the discarded node goes with it. Only a region that made it
    // into the final AST can contribute an import to the module.
    // `returnVars` rides along for the same reason and with the same
    // speculative-parse caveat: a `/var` inside a region binds a `let` the
    // region itself has no statement position for, so the surrounding module
    // declares it (design §2.4).
    mx: { range: [start, end], hoistedImports, returnVars },
  };
}

function locAt(
  source: string,
  offset: number,
): { line: number; column: number; index: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index++) {
    if (source.charCodeAt(index) === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart, index: offset };
}

function offsetAt(source: string, line: number, column: number): number {
  let currentLine = 1;
  let offset = 0;
  while (currentLine < line && offset < source.length) {
    if (source.charCodeAt(offset++) === 10) currentLine++;
  }
  return Math.min(source.length, offset + column);
}

/**
 * Raises an MX parse error and returns it to be thrown.
 *
 * `raise` only throws when `errorRecovery` is off; with it on it records the
 * error and returns. The bridge has no valid node to hand back either way — the
 * MX region did not parse — and returning `null` as an expression makes Babel
 * crash later on `expr.type`. So the error is always thrown: `tryParse` catches
 * thrown SyntaxErrors and rolls back, and a top-level parse surfaces it with
 * its position intact, which is what an unparseable region should do under
 * either setting.
 */
function raiseAndThrow(
  parser: MxParserHost,
  // biome-ignore lint/suspicious/noExplicitAny: matches the vendored raise signature
  toParseError: any,
  at: Position,
  // biome-ignore lint/suspicious/noExplicitAny: matches the vendored raise signature
  details: any,
): unknown {
  return parser.raise(toParseError, at, details);
}

/**
 * Moves the tokenizer to `end` (just past the root tag's close) and reads the
 * next token from there.
 *
 * `pos` alone is not enough:
 *
 * - `curLine`/`lineStart` feed every subsequent `loc`, so they are recomputed
 *   by scanning the region MX consumed.
 * - `start`/`startLoc`/`end`/`endLoc` must be made to describe the MX region as
 *   if it were the token just read. `next()` copies `endLoc` into
 *   `lastTokEndLoc`, and `finishNode` ends every *enclosing* node at
 *   `lastTokEndLoc` — so leaving `endLoc` pointing at the tag-name token (where
 *   the JSX plugin left it) ends the enclosing arrow, return, property or
 *   conditional at `<div` instead of at the closing tag. `hasPrecedingLineBreak`
 *   compares against the same field, so a stale value also makes every
 *   multi-line MX element look like it was followed by a line break, silently
 *   swallowing the missing semicolon in `<div>\n</div> foo`.
 *
 * `type` is still not set by hand — `next()` re-derives it from the
 * repositioned `pos`, which is what keeps the token and the position
 * consistent.
 */
function repositionTokenizer(
  parser: MxParserHost,
  source: string,
  start: number,
  end: number,
  contextDepth: number,
): void {
  const { state } = parser;

  const startLine = state.curLine;
  const startLineStart = state.lineStart;

  let line = startLine;
  let lineStart = startLineStart;
  for (let i = state.pos; i < end; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }

  state.pos = end;
  state.curLine = line;
  state.lineStart = lineStart;

  // Describe the whole MX region as the token that was just consumed, so the
  // next `next()` records an accurate `lastTokEndLoc`.
  state.start = start;
  state.startLoc = positionAt(source, start, state.startIndex);
  state.end = end;
  state.endLoc = new Position(line, end - lineStart, end + state.startIndex);

  state.context.length = contextDepth;
  if (state.context[state.context.length - 1] === tc.j_expr) {
    // biome-ignore lint/suspicious/noExplicitAny: state is internal
    (parser.state as any).canStartJSXElement = true;
  }
  parser.next();
}

/** A real `Position` for `raise`, which type-tests it with `instanceof`. */
function positionAt(
  source: string,
  offset: number,
  startIndex: number,
): Position {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return new Position(line, offset - lineStart, offset + startIndex);
}

/**
 * Options for sub-parsing an expression range. The MX region's own start
 * offsets are absolute already, so `startIndex` is set per range by the caller;
 * everything else follows the outer parse so nested MX keeps working.
 */
// biome-ignore lint/suspicious/noExplicitAny: the vendored options bag
function mxSubParseOptions(options: any): any {
  return {
    plugins: options?.plugins ?? ["typescript", "jsx"],
    sourceType: options?.sourceType ?? "module",
    errorRecovery: false,
  };
}
