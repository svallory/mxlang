import { parseExpression } from "../babel/index.ts";
import { types as tc } from "../babel/tokenizer/context.ts";
import { Position } from "../babel/util/location.ts";
import { MxErrors } from "./errors.ts";
import type { HoistedDefine, HoistedImport } from "./hoist-imports.ts";
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
    /** Function parameters known before Babel registers them in its scope. */
    mxFunctionParamNames: Array<Set<string>>;
  };
  // biome-ignore lint/suspicious/noExplicitAny: matches the vendored raise signature
  raise(toParseError: any, at: Position | any, details?: any): unknown;
  next(): void;
  // biome-ignore lint/suspicious/noExplicitAny: the vendored options bag
  options: any;
  // biome-ignore lint/suspicious/noExplicitAny: Babel's own node type is internal
  finishNode?: any;
  /** Babel's active lexical scopes, used to hide shadowed module imports. */
  scope?: {
    scopeStack?: Array<{ names?: Map<string, unknown> }>;
  };
}

function visibleImportSpecifiers(
  parser: MxParserHost,
): ReadonlyMap<string, string> {
  const imports =
    (parser.options?.mxImportSpecifiers as
      | ReadonlyMap<string, string>
      | undefined) ?? new Map<string, string>();
  const localScopes = parser.scope?.scopeStack?.slice(1) ?? [];
  if (localScopes.length === 0) return imports;

  const visible = new Map(imports);
  for (const name of imports.keys()) {
    if (isShadowedLocally(parser, localScopes, name)) visible.delete(name);
  }
  return visible;
}

/**
 * Every value the surrounding module binds at its top level (decision 114).
 *
 * Deliberately **not** shadow-filtered the way `visibleImportSpecifiers`
 * filters imports for dependency resolution: Marko's own rule
 * (`tag.scope.hasBinding(tagName)`, `tag-name-type.ts:95-97`) is that *any*
 * in-scope binding — including one a nearer lexical scope shadows — makes a
 * capitalized tag resolved, as a dynamic tag reference to whichever binding
 * is actually in scope at that point. Shadowing changes *what it prints as*
 * (a separate, pre-existing concern this bridge's import-shadowing logic
 * already handles for `importSpecifiers`), never *whether* the name is
 * resolvable at all — filtering it here would make a shadowed name
 * unresolved instead of a reference to the shadowing local, which is not
 * what Marko does.
 */
function moduleBindings(parser: MxParserHost): ReadonlySet<string> {
  return (
    (parser.options?.mxModuleBindings as ReadonlySet<string> | undefined) ??
    new Set<string>()
  );
}

/**
 * The subset of `moduleBindings`' non-import names whose value is not
 * statically a function/arrow/class (local extension of decision 116).
 * Unfiltered by local shadowing for the same reason `moduleBindings` itself
 * is: this set only classifies names `moduleBindings` already resolves, so
 * it inherits that set's own (deliberate) lack of shadow-filtering rather
 * than needing its own.
 */
function unknownModuleBindings(parser: MxParserHost): ReadonlySet<string> {
  return (
    (parser.options?.mxUnknownModuleBindings as
      | ReadonlySet<string>
      | undefined) ?? new Set<string>()
  );
}

/**
 * Which of `importSpecifiers`' bindings is a *default* import from a
 * `.marko`/`.mx` source — Marko's own statically-resolved component case
 * (decision 116; `@mxlang/core`'s `isMarkoOrMxSpecifier`, shared rather than
 * duplicated). Shadow-filtered the same way `visibleImportSpecifiers` is,
 * and for the identical reason: a binding a nearer scope shadows is not the
 * module's own import any more, so it cannot carry the module import's
 * provenance either.
 */
function visibleImportDefaultFromMarkoOrMx(
  parser: MxParserHost,
): ReadonlySet<string> {
  const names =
    (parser.options?.mxImportDefaultFromMarkoOrMx as
      | ReadonlySet<string>
      | undefined) ?? new Set<string>();
  const localScopes = parser.scope?.scopeStack?.slice(1) ?? [];
  if (localScopes.length === 0) return names;

  const visible = new Set(names);
  for (const name of names) {
    if (isShadowedLocally(parser, localScopes, name)) visible.delete(name);
  }
  return visible;
}

function isShadowedLocally(
  parser: MxParserHost,
  localScopes: Array<{ names?: Map<string, unknown> }>,
  name: string,
): boolean {
  return (
    localScopes.some((scope) => scope.names?.has(name)) ||
    parser.state.mxFunctionParamNames.some((params) => params.has(name))
  );
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

  // A fragment region (`<>…</>`) is only claimed when the host opted in; the
  // jsx plugin routes `<>` here under the same condition.
  const fragment =
    parser.options?.mxRegionFragment === true &&
    source.charCodeAt(start + 1) === 62; /* > */
  const { root, end, errors } = walkMxRegion(source, start, { fragment });

  if (fragment && errors.length > 0) {
    // htmljs-parser reports a `<>` inside an element child as a mismatched
    // close far from the cause. If a `<>` precedes the first error, that is
    // the mistake to name.
    const nested = source.indexOf("<>", start + 2);
    if (nested !== -1 && nested < (errors[0]?.end ?? 0)) {
      throw raiseAndThrow(
        parser,
        MxErrors.NestedFragment,
        positionAt(source, nested, parser.state.startIndex),
        undefined,
      );
    }
  }

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
    const context = {
      ...computeMxRegionContext(parser.state.mxRegionParents, startLoc.index),
      ...(fragment ? { fragment: true } : {}),
    };
    regionContext = context;
    const result = positionCheck(context);
    if (!result.ok) {
      throw raiseAndThrow(parser, MxErrors.PositionRejected, startLoc, {
        message: result.message,
      });
    }
  }

  // Which host lowers this region is the caller's to decide, on the same
  // options-bag channel `mxRegionPositionCheck` uses — the bridge runs
  // inside the tokenizer and has no other route to an integration. The
  // parser owns no host of its own, so a region with the grammar on and no
  // hook is a compile error naming the missing option, not a silent default.
  const regionCompile = parser.options?.mxRegionCompile as
    | MxRegionCompile
    | undefined;
  if (!regionCompile) {
    throw raiseAndThrow(parser, MxErrors.MissingRegionCompile, startLoc, {
      filename: parser.options?.sourceFilename ?? "input.mx",
    });
  }

  if (fragment) {
    const nested = nestedFragmentAt(root, source);
    if (nested !== null) {
      throw raiseAndThrow(
        parser,
        MxErrors.NestedFragment,
        positionAt(source, nested, parser.state.startIndex),
        undefined,
      );
    }
  }

  // What the host lowers. A fragment region hands over its children only: the
  // host's template lowering already takes several roots, and `<>`/`</>` are
  // this bridge's syntax, not the host's.
  const inner = fragment
    ? { start: start + 2, end: root.closeRange?.start ?? end }
    : { start, end };

  let node: unknown;
  try {
    const region = source.slice(inner.start, inner.end);
    const { code, hoistedImports, hoistedDefines, returnVars, dependencies } =
      regionCompile({
        source: region,
        filename: parser.options?.sourceFilename ?? "input.mx",
        // The region's syntactic position, already computed for the veto
        // above. Handed over so a host that needs it downstream — to shape
        // its emit, not merely to accept or reject — needs no side channel
        // back into the parser. Undefined when no position check ran, since
        // the stack is only tracked then.
        context: regionContext,
        fragment,
        baseOffset: inner.start,
        baseLine: startLoc.line - 1,
        baseColumn: startLoc.column + (fragment ? 2 : 0),
        // Registered custom tags reach a host only through here, for the same
        // reason the hook itself does.
        customTags: parser.options?.mxCustomTags,
        defaultTag: parser.options?.mxDefaultTag,
        importSpecifiers: visibleImportSpecifiers(parser),
        moduleBindings: moduleBindings(parser),
        importDefaultFromMarkoOrMx: visibleImportDefaultFromMarkoOrMx(parser),
        unknownModuleBindings: unknownModuleBindings(parser),
      });
    const parsedCode = parseRegionCode(code, {
      ...mxSubParseOptions(parser.options),
      mx: false,
      startIndex: start,
      startLine: startLoc.line,
      startColumn: startLoc.column,
    });
    node = parsedCode.node;
    remapExpressionLocations(node, root, parsedCode.code, source, start, end);
    stampRoot(
      node,
      source,
      start,
      end,
      hoistedImports,
      hoistedDefines,
      returnVars,
      dependencies,
    );
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

  noteSiblingRoot(parser, source, end);
  repositionTokenizer(parser, source, start, end, contextDepth);
  return node;
}

/**
 * The offset of a `<>` inside a fragment's children, or null. htmljs-parser
 * reads a nested `<>` as plain text, which would lower to a literal `<>` in
 * the output; a fragment has no meaning inside a fragment, so it is refused.
 */
function nestedFragmentAt(root: MxElement, source: string): number | null {
  const stack: MxElement[] = [root];
  for (let el = stack.pop(); el; el = stack.pop()) {
    for (const child of el.children) {
      if (child.kind === "element") stack.push(child.element);
      else if (child.kind === "text") {
        const at = source.indexOf("<>", child.range.start);
        if (at !== -1 && at < child.range.end) return at;
      }
    }
  }
  return null;
}

/**
 * Records that a second, well-formed root follows a region directly
 * (`<a/><b/>`), so a parse failure it causes can be reported as the rule it
 * breaks. Purely a hint: it changes nothing about what parses.
 *
 * The tokenizer resumes at `end` and reads `<b/>` as a relational operator
 * followed by garbage, so the failure is a Babel error about a regular
 * expression or an unexpected token that names no MX rule. `parse` rewrites
 * that failure — and only a failure — using these hints. Input that parses
 * today (`<b/> < c`, `<b/> <c`) never reaches the rewrite, so it is not
 * rejected here.
 */
function noteSiblingRoot(
  parser: MxParserHost,
  source: string,
  end: number,
): void {
  const hints = parser.options?.mxSiblingHints as
    | Array<{ start: number; end: number }>
    | undefined;
  if (!hints) return;
  let at = end;
  while (at < source.length && /\s/.test(source.charAt(at))) at++;
  if (source.charCodeAt(at) !== 60 /* < */) return;
  const next = source.charAt(at + 1);
  const fragment = next === ">" && parser.options?.mxRegionFragment === true;
  // `< c` (a space) is a comparison, never a root; so is `<=` and `<<`.
  if (!fragment && !/[A-Za-z_$@:]/.test(next)) return;
  const sibling = walkMxRegion(source, at, { fragment });
  if (sibling.errors.length > 0 || sibling.root === null) return;
  hints.push({ start: at, end: sibling.end });
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
 * One kind of node is handled before those three: the type of a `satisfies`
 * or `as` the host generated (one that is not inside a matched expression,
 * so the author did not write it). It has no source text at all, and its
 * location is removed rather than repaired. The emitted region is one line
 * and the authored one may not be, so such a type's generated offsets can
 * name several source lines. The printer retains lines, and between a type's
 * name and its type arguments it may not break one, so it parenthesized the
 * arguments to get there: `NonNullable(\n<Parameters<...>>)`, which is not
 * TypeScript. A node without a location is printed where the text already is.
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

  const detach = (value: unknown) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) detach(item);
      return;
    }
    const record = value as Record<string, unknown>;
    delete record.loc;
    for (const [key, child] of Object.entries(record)) {
      if (key !== "extra") detach(child);
    }
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

      if (
        !best &&
        (record.type === "TSSatisfiesExpression" ||
          record.type === "TSAsExpression")
      ) {
        detach(record.typeAnnotation);
        visit(record.expression);
        return;
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
  hoistedDefines: HoistedDefine[] = [],
  returnVars: string[] = [],
  dependencies: string[] = [],
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
    mx: {
      range: [start, end],
      hoistedImports,
      hoistedDefines,
      returnVars,
      dependencies,
    },
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

/**
 * Parses a host's compiled `code` as a standalone expression, retrying with
 * its outer braces stripped when the first attempt fails and `code` is
 * wrapped in exactly one JSX child-expression-container pair.
 *
 * A host emits `code` for two different consumers with different shape
 * requirements, and both are legitimate, existing contracts a host cannot
 * satisfy simultaneously with one shape: this bridge always re-parses the
 * *whole region* as one standalone expression (`<Widget/>` -> `<Widget />`,
 * not `{<Widget />}`), while a caller that splices a host's `code` directly
 * into a surrounding element's JSX children (`<ul>${code}</ul>`) needs the
 * JSX child-expression-container braces a dynamic-tag dispatch emits
 * (`@mxlang/solid`'s `#dynamicComponent`: `{(() => {...})()}`, correct only
 * as a JSX child, not as a standalone expression on its own). A region
 * whose entire content is one dynamic tag is exactly this shape — Solid's
 * lowering has no way to know, at emit time, which of the two contracts its
 * caller wants.
 *
 * Retried only on a parse failure, so `code` that already parses (every
 * other emitted shape, and every other host) never takes the second
 * attempt — no behavior changes for any case that worked before. The
 * retried parse is what both the returned `node` and its `code` refer to,
 * so caller-side remapping (`remapExpressionLocations`) stays consistent
 * with whichever text actually got parsed.
 */
function parseRegionCode(
  code: string,
  // biome-ignore lint/suspicious/noExplicitAny: the vendored options bag
  options: any,
): { node: unknown; code: string } {
  try {
    return { node: parseExpression(code, options), code };
  } catch (firstError) {
    if (code.startsWith("{") && code.endsWith("}")) {
      const unwrapped = code.slice(1, -1);
      try {
        return { node: parseExpression(unwrapped, options), code: unwrapped };
      } catch {
        // Fall through to the original error: unwrapping did not help, so
        // the original failure is the more useful one to report.
      }
    }
    throw firstError;
  }
}
