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

import type { CustomTag } from "@mxlang/core";
import type { Position } from "./util/location.ts";

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
};

/** One synthesized import a region needs written into its module. */
export interface HoistedImport {
  /** The `import X from "./y.mx"` statement text. */
  code: string;
  /** The local binding the emitted region references. */
  binding: string;
  /** The module specifier, as written in `code`. */
  specifier: string;
  /**
   * The template's resolved absolute path.
   *
   * Dedupe and authored-import reuse key on this, not on the specifier: two
   * spellings (`./tags/icon.mx`, `./tags/../tags/icon.mx`) are one file and
   * must collapse to one import.
   */
  resolvedPath: string;
}

/**
 * One `<define>` a region hoisted to module scope (decision 110b).
 *
 * Unlike a `HoistedImport`, there is nothing to reuse or dedupe against: the
 * declaration exists nowhere until the region mints it, so the binding is
 * always a fresh gensym (`@mxlang/solid`'s `generatedDefineBinding`), never
 * the author's own `<define>` name — the same reason a discovered tag's
 * import is always gensym'd rather than guessing it is safe to call the
 * local binding `icon`.
 */
export interface HoistedDefine {
  /** The `function __mx_DefineN(params) { return <>...</>; }` text. */
  code: string;
  /** The gensym'd module-scope binding the region calls. */
  binding: string;
}

/** Where a region appeared, described without host-specific knowledge. */
export interface MxRegionContext {
  /** True when the region is a fragment (`<>…</>`) claimed through
   *  `mxRegionFragment`. Absent (not `false`) for an ordinary region, and for
   *  every region when the option is off. Set by the bridge after the
   *  position is computed, so a position check can accept a region root and
   *  still reject a fragment there or word the two differently:
   *  `@mxlang/angular`'s check uses it to say a fragment is only allowed as the
   *  root of a `template:` region. */
  fragment?: boolean;
  /** Innermost enclosing object-property key, if any: `template` in
   *  `@Component({ template: <div/> })`, and in `{ x: { template: <region/> } }`
   *  too (innermost, not `x`). Null in any other position, or when the region
   *  sits inside a spread rather than a named property. */
  propertyKey: string | null;
  /** The innermost enclosing decorator's own name, as a single-element list,
   *  or `[]` when the region is not inside any decorator call — scoped to
   *  match `propertyKey`/`isDirectPropertyValue`/`argumentIndex`, which are
   *  all computed relative to this same innermost decorator frame. A class
   *  expression nested inside an outer decorator's own argument can carry a
   *  second, inner decorator (`@Outer({ x: class { @Component({ template:
   *  <div/> }) accessor y } })`), so more than one decorator really can
   *  enclose a region; the list shape (rather than `string | null`) is kept
   *  in case a future syntax proposal makes even the innermost frame
   *  ambiguous. See `enclosingDecoratorNames` for the rest of the chain. */
  decoratorNames: readonly string[];
  /** Names of every decorator enclosing the region *other than* the
   *  innermost one (whose name is `decoratorNames`'s sole entry), outermost
   *  first. Empty whenever there is one decorator or none. Exists so a host
   *  can still see the full nesting even though every other field is scoped
   *  to the innermost frame only. */
  enclosingDecoratorNames: readonly string[];
  /** The index of the decorator-call argument that (transitively) encloses
   *  the region, or `null` when the region isn't inside any decorator's
   *  argument list at all. `@Component({ template: <div/> })` (the
   *  canonical, single-argument shape) is `0`;
   *  `@Component(opts, { template: <div/> })` is `1` — a distinction
   *  `propertyKey`/`isDirectPropertyValue` alone can't make, since both
   *  shapes otherwise look identical to them. */
  argumentIndex: number | null;
  /** True iff the region is the immediate value of a property of the
   *  decorator argument object itself.
   *
   *  Every frame from the enclosing decorator (or the start of the stack, if
   *  none) up to and including the property directly enclosing the region
   *  must be an unbroken, unwrapped chain: each `boundary` frame in that
   *  span (the decorator's own call-argument slot, the object literal's own
   *  braces, …) must share the exact same `valueStart` — the offset where
   *  its own construct began — because nothing but whitespace may separate
   *  "the decorator's sole argument" from "the object literal that argument
   *  is," and the final `property` frame's `valueStart` must equal the
   *  region's own start. Any wrapper that shifts one of those offsets away
   *  from the others breaks the chain and makes this `false`:
   *  `@Component(wrap({ template: <div/> }))` (the `wrap(...)` call sits
   *  between the decorator's argument slot and the object), `@Component(c ?
   *  { template: <div/> } : y)` (the ternary condition does), and
   *  `@Component([{ template: <div/> }])` (the array does) are all `false`,
   *  even though each one's `template` property is itself an exact,
   *  unwrapped match one level down — a boundary opened *before* the first
   *  property frame in the chain always breaks it, regardless of what
   *  happens deeper in. `{ x: { template: <region/> } }` is `false` for the
   *  same reason: `x` is the property directly enclosing the region's
   *  ultimate ancestor object, and the region does not start at `x`'s own
   *  value — even though `propertyKey` reports the innermost `"template"`.
   *  An exact-position test, not a shape heuristic: no wrapper shape
   *  (ternary, parenthesized, arrow body, spread, a further-nested object,
   *  …) needs to be enumerated one by one. */
  isDirectPropertyValue: boolean;
}

/** A host's veto on a region's syntactic position. */
export type MxRegionPositionCheck = (
  context: MxRegionContext,
) => { ok: true } | { ok: false; message: string };

/**
 * One frame of the minimal parent stack the parser instruments while
 * `mxRegionPositionCheck` is set. The tokenizer's own `context: TokContext[]`
 * (`tokenizer/state.ts`) is brace/template disambiguation, not a syntactic
 * parent path, so this is tracked separately and only when a host asked for
 * it — see `bridge.ts:83-86`'s options-bag channel and the design note at
 * `notes/investigations/angular-ng-mx-spike.md` §Q4.
 */
export type MxRegionParentFrame =
  | {
      kind: "property";
      /**
       * The property's own key, or `null` for a spread element's operand
       * (`...expr` inside an object literal) — a spread has no key to
       * report, but its operand still opens exactly the same kind of nested
       * value position a named property's value does, and `isDirectPropertyValue`
       * needs to see it to tell `{ template: <div/> }` (direct) apart from
       * `{ ...{ template: <div/> } }` (not: the region sits one object
       * literal deeper than the one directly inside the decorator's own
       * call argument).
       */
      key: string | null;
      /**
       * The absolute source offset where this property's (or spread's)
       * value expression began being parsed (`parseObjectProperty`, right
       * after eating the `:` or the `...`). `isDirectPropertyValue` compares
       * the region's own start against the **outermost** such frame's
       * `valueStart` — an exact-position test, so any wrapper between that
       * frame's value-start and the region (a ternary, a parenthesized
       * expression, `${...}`, an arrow body, `||`, an assignment, a sequence
       * expression, a further-nested object/spread/property, …) makes it
       * false, with no need to enumerate wrapper shapes one by one.
       */
      valueStart: number;
    }
  | { kind: "decorator"; name: string }
  /**
   * Any other value-producing construct: an object literal's braces
   * (`parseObjectLike`), or one item of a call-argument/array list
   * (`parseExprListItem`, the single choke point both share).
   * `propertyKey`/`decoratorNames` ignore these entirely, but
   * `isDirectPropertyValue` reads their `valueStart` too — see its own doc
   * comment on `MxRegionContext` for why a `boundary`'s own start offset
   * (not just its presence) is what tells "the decorator's sole argument is
   * this exact object literal" apart from "something else wraps it."
   * `argumentIndex` is non-null only for a `parseExprListItem` boundary that
   * is itself one of a decorator's own top-level call arguments — `null` for
   * an object literal's own braces (`parseObjectLike`) and for any nested
   * list item (an array element, a call argument two levels deep, …), which
   * have no bearing on `MxRegionContext.argumentIndex`.
   */
  | { kind: "boundary"; valueStart: number; argumentIndex: number | null };

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
  customTags?: Record<string, CustomTag>;
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
   * Where each `importSpecifiers` binding's `import` statement starts (1-based
   * line, 0-based column), so a host can position decision 164's warning at
   * the import. A name may be absent; the warning then omits the position.
   */
  importSites?: ReadonlyMap<string, { line: number; column: number }>;
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

/**
 * What the fork needs from whoever supplies MX syntax, injected through the
 * `mxHooks` parser option. The fork imports nothing from the bridge: it calls
 * these. `mx: true` without them is an error, never a silent plain-TSX parse.
 */
export interface MxHooks {
  /**
   * Parses one MX element at `startLoc` and leaves the tokenizer on the first
   * token after the root closes. Returns an ordinary lowered JSX node.
   */
  parseRegion(parser: MxParserHost, startLoc: Position): unknown;
  /** Builds the "multiple roots" parse error raised at `position`. */
  multipleRootsError(position: Position): unknown;
}

/**
 * Reads a static property-key name off an already-parsed, non-computed
 * `ObjectProperty` key node (`Identifier`, `StringLiteral`, `NumericLiteral`).
 * Null for a computed key or any other key shape, in which case the property
 * contributes no `propertyKey`/direct-value frame — a host's check simply
 * sees an unrelated position, matching a non-decorator call's own shape.
 */
export function mxPropertyKeyName(
  computed: boolean,
  key: { type: string; name?: string; value?: unknown },
): string | null {
  if (computed) return null;
  if (key.type === "Identifier" && typeof key.name === "string") {
    return key.name;
  }
  if (
    (key.type === "StringLiteral" || key.type === "NumericLiteral") &&
    typeof key.value !== "undefined"
  ) {
    return String(key.value);
  }
  return null;
}

/**
 * Reads a decorator's own name off its (possibly call-wrapped) expression:
 * `Component` from either `@Component` or `@Component(...)`, and the final
 * property name from a member expression (`@ns.Component`). `unknown`-typed
 * because callers pass Babel expression node unions this module has no
 * dependency on; anything else (a computed member, a non-identifier callee)
 * yields null, contributing no `decorator` frame.
 */
export function decoratorNameFromExpression(expr: unknown): string | null {
  const node = expr as
    | { type?: unknown; callee?: unknown; name?: unknown; property?: unknown }
    | null
    | undefined;
  if (!node || typeof node.type !== "string") return null;
  const target =
    node.type === "CallExpression"
      ? (node.callee as typeof node | undefined)
      : node;
  if (!target || typeof target.type !== "string") return null;
  if (target.type === "Identifier") {
    return typeof target.name === "string" ? target.name : null;
  }
  if (target.type === "MemberExpression") {
    const property = target.property as { name?: unknown } | undefined;
    return typeof property?.name === "string" ? property.name : null;
  }
  return null;
}
