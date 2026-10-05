/**
 * `@mxlang/core`: the Marko-node consumer every MX host is built on.
 *
 * Resolves Marko's AST to the host-independent IR, with everything
 * host-specific behind `HostDeclarations`. Decisions 70 to 72 and 79: MX is
 * the language, this package is the core, and each host supplies declarations
 * plus an `Emitter`.
 *
 * This file previously served two dialects — `@mxlang/html`'s retired `.mx`
 * dialect, alongside `@mxlang/html`'s stock `.marko` — until decision
 * 68 retired `.mx` and deleted `@mxlang/html` entirely. Two things that were
 * true while both existed, kept here because they still explain choices this
 * core makes:
 *
 * - **Tag disposition.** Decision 65 replaced "what my code can't do" with
 *   "what this target can't do": a construct either contributes output bytes
 *   (lower), only configures behaviour after the first render (inert), or
 *   evaluates to an initial value. The policy declares its own table.
 * - **Element resolution** asks Marko's taglib lookup, so a tag Marko adds or
 *   removes reaches it on a pin bump (ADR 0001's whole point) — `.mx`'s own
 *   hand-carried element set is gone with the rest of that dialect.
 *
 * Two shapes of Marko's AST drive nearly everything here, both measured
 * against 5.42.5 rather than assumed:
 *
 * - Whitespace is already decision 33. Marko's own `onText` drops a
 *   whitespace-only run containing a newline and collapses a newline-free run
 *   to one space, so `MarkoText.value` arrives normalized and this file does
 *   not re-normalize it.
 * - Statement tags (`import`, `static`, `export`) parse as *tags* whose
 *   attributes are word soup, and their `start`/`end` are undefined. Their
 *   `loc` line/column, however, spans exactly the statement, so the source
 *   text is sliced back out by `loc` and re-parsed.
 */

import type {
  AtomFacts,
  ContractFact,
  DerivedDeclaration,
} from "./atom-contracts.ts";
import type { CalleeInput } from "./callee-input.ts";
import type { CustomTag, TagCall } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import { nearestHtmlElement, nearestName } from "./did-you-mean.ts";
import type { Atom, Expr, IrNode, Position } from "./ir.ts";
import type { SourceSpan } from "./mapping.ts";
import { markoBabel } from "./marko-frontend.ts";
import type { TargetLookup } from "./target-descriptor.ts";

/**
 * Marko's own bundled Babel — parser, traverse and types in one module.
 *
 * The core parses JS in two places (an `import` statement's bindings, and an
 * expression whose identifier references a host may rewrite). Both used
 * `@mxlang/parser`'s vendored Babel while this file lived in the translator,
 * which made the string host depend on the *Solid host parser* package for a
 * plain `parse` call. `@marko/compiler` already bundles a full Babel, and
 * these nodes belong to that instance anyway — so the core asks it. Loaded
 * lazily through `marko-frontend.ts` (decision 159: bundled into core's dist).
 */
export { markoBabel };

/**
 * Raised for a construct that parses as Marko but has no string lowering.
 *
 * Plain fields, not TS parameter properties: Node's native strip-only TS mode
 * (used by, among others, Vite's own build process when it loads this module
 * unbundled) rejects parameter properties outright, and this class is public
 * API that a consumer with no build step may import directly.
 */
export class TranslateError extends Error {
  readonly line: number;
  readonly column: number;
  /**
   * The cross-copy brand (decisions 129/132 §4.4, mitigation 2). Set through
   * `Symbol.for`, so two copies of `@mxlang/core` in one process — a bundled
   * tool and a project-resolved host, or the published `dist` beside a
   * different core — agree on the same symbol and {@link isTranslateError}
   * recognises each other's errors, where `instanceof` silently would not.
   */
  declare readonly [TRANSLATE_ERROR_BRAND]: true;
  /**
   * The file `line`/`column` are measured in, when it is not the file being
   * compiled — a diagnostic raised inside an inlined tag template.
   *
   * `undefined` for every error the compiler raises about the file it was
   * given, which is why no existing consumer had to change: only a reporter
   * that can address a second file need read it.
   */
  readonly file?: string;
  /**
   * Further source spans the error is about, in file offsets: a duplicate
   * declaration carries the first and the second (decision 156). The position
   * (`line`/`column`) is the last one.
   */
  spans?: readonly SourceSpan[];
  /**
   * Every callee file the failed compile's `readCalleeInput` had already
   * resolved before the error was raised (decision 106/107). Set by
   * `compileSource`'s catch, from the same-shaped `Ctx.dependencies` a
   * successful compile drains into `CompileResult.dependencies`, and by the
   * discovery scans (`scanCustomTags`, `scanCached`), which attach the partial
   * scan inputs read before the failure — a
   * dependent-re-diagnosis integration (the language server) needs this on a
   * *failing* compile too, since a caller reporting "missing required
   * attribute tag" is exactly the caller that must be re-checked once the
   * callee's declaration changes again.
   */
  dependencies?: string[];
  /**
   * The unit's atom facts, for `atomCandidates`. Set only when the error came
   * from the file-level atom check (a clash, an unknown atom, a string against
   * a `ref` atom), which runs after every call was seen, so the facts are
   * complete. An error thrown before it (a type error, a missing attribute, an
   * `analyze` failure, a parse error) leaves it unset: a consumer then keeps
   * the facts of the last good `CompileResult` instead of partial ones.
   */
  atomFacts?: AtomFacts;

  constructor(message: string, line: number, column: number, file?: string) {
    super(message);
    this.name = "TranslateError";
    this.line = line;
    this.column = column;
    this.file = file;
    Object.defineProperty(this, TRANSLATE_ERROR_BRAND, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

/**
 * The brand a `TranslateError` carries, from the global symbol registry so
 * every copy of core uses one key. Never exported by name: it is the value
 * `Symbol.for` returns, and the only way to test an error for it is
 * {@link isTranslateError}.
 */
const TRANSLATE_ERROR_BRAND: unique symbol = Symbol.for(
  "mxTranslateError",
) as typeof TRANSLATE_ERROR_BRAND;

/**
 * Whether `error` is a `TranslateError`, whoever raised it.
 *
 * `instanceof` alone is wrong across a copy boundary (design note §4.4): a
 * host resolved from the project brings its own `@mxlang/core`, so the
 * `TranslateError` it throws is not the class the tool checks against, and
 * every positioned error from it degrades to a wrapped, positionless one.
 * The brand is a `Symbol.for` (shared registry) plus the name, so a foreign
 * copy's error passes and an unrelated error that merely carries a position
 * does not.
 */
export function isTranslateError(error: unknown): error is TranslateError {
  return (
    error instanceof TranslateError ||
    (typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[TRANSLATE_ERROR_BRAND] === true &&
      (error as { name?: unknown }).name === "TranslateError")
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Node = any;

export const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * How a dialect disposes of one tag name (decision 65).
 *
 * The test for every construct is whether it contributes to the emitted bytes
 * or only configures behaviour after the first render. "My code cannot lower
 * this" is never a disposition; only "this target cannot express it" is.
 */
export type Disposition =
  | {
      kind: "inert";
      reason: string;
      /**
       * The shape the tag is inert *in*, per its own Marko tag definition.
       *
       * Inert means "this construct emits nothing", never "whatever the author
       * wrote here may be discarded". A tag whose definition takes no body
       * still has to reject one, or authored markup disappears from a
       * successful compile — the silent-drop class (S8) the field guard exists
       * to close, reopened for every inert row.
       *
       * `body: "text"` is for a tag whose definition declares a raw-text body
       * (`<script>`): the text is genuinely consumed and emits nothing.
       */
      body?: "none" | "text";
      /**
       * Whether the tag's own definition accepts attributes beyond its value.
       *
       * Per tag, not uniform, because Marko is: `<effect foo="bar"/>` and
       * `<log=1 foo="bar"/>` are "does not support the `foo` attribute" there,
       * while `<lifecycle foo="bar"/>` compiles — a lifecycle tag's
       * attributes *are* its configuration. Verified against Marko for each
       * row.
       */
      attributes?: "none" | "any";
    }
  | { kind: "error"; reason: string };

/**
 * A host's rewrite for references to one registered binding (decision 70).
 *
 * `register("count", ref => `${ref}()`)` makes `${count + 1}` emit
 * `count() + 1` in a host whose `<let>` is a Solid signal.
 */
export type BindingRewrite = (ref: string) => string;

/**
 * The registry of reference rewrites in scope (decision 70's third hook).
 *
 * Registration is flat rather than scoped: a name registered anywhere in the
 * template rewrites every later reference to it. That is enough for the
 * stateful tags this exists for (a `<let>` names a binding for the rest of
 * the render), and a host that needs block scoping registers and unregisters
 * around its own emit call.
 */
export interface BindingRegistry {
  register(name: string, rewrite: BindingRewrite): void;
  /** Forgets a registration, for a host unwinding a scope it opened. */
  unregister(name: string): void;
  /** The rewrite for `name`, or undefined when it is not registered. */
  get(name: string): BindingRewrite | undefined;
  /** Whether anything is registered at all — the fast path for `expr`. */
  get size(): number;
  /** Every registration as it stands, for `scopeBindings` to restore. */
  snapshot(): Array<[string, BindingRewrite]>;
  /** Replaces every registration with a previous `snapshot()`. */
  restore(saved: Array<[string, BindingRewrite]>): void;
}

export interface Ctx {
  /** Authored tag ancestors, innermost last; control flow is transparent and units start empty. */
  authoredAncestors?: string[];
  /** The Marko nodes behind `authoredAncestors`, same order (atom contract scopes). */
  authoredAncestorNodes?: Node[];
  /** Every custom tag call of this unit, by node, for the atom contract check. */
  contractFacts?: Map<Node, ContractFact>;
  /** Names `analyze` hooks declared with `ctx.declare`. */
  contractDerived?: DerivedDeclaration[];
  /** The unit's atom facts, set when the atom check starts (every call has been seen). */
  atomFacts?: AtomFacts;
  source: string;
  /** Absolute or caller-supplied filename used to resolve injected imports. */
  filename: string;
  lines: string[];
  /**
   * Statements to place at the head of the function currently being emitted
   * (decision 70's hoist hook). `hoist()` appends here; the lowerer drains it
   * at the nearest function boundary.
   */
  prelude: Array<{ code: string; node: Node }>;
  /**
   * Lifts a statement to the head of the enclosing function — the render
   * function, or the nearest `Define` block.
   *
   * The hook a host needs for a stateful tag whose declaration must outlive
   * the block it was written in (a signal declared inside an `<if>` but read
   * after it). Emitted verbatim, at the function's own indent.
   */
  hoist(code: string, node: Node): void;
  /** Reference rewrites for registered bindings; see `BindingRegistry`. */
  bindings: BindingRegistry;
  /** `<define>`s bound so far, name -> declared parameter names in order. */
  defines: Map<string, string[]>;
  /**
   * Local *value* bindings introduced by the template's `import` statements
   * — never a type-only one (a whole `import type` or an inline
   * `{ type X }` specifier), since neither introduces a value a capitalized
   * tag could resolve to (decision 114/115). Every host's own `isComponent`
   * consults this set directly, so keeping it value-only here is what makes
   * every host correct with no per-host change.
   */
  imports: Set<string>;
  /**
   * Every name `imports` would have held with no type-only exclusion — used
   * only where "is this exact name already imported at all, value or type"
   * is the real question (`needsAttrTagImport`'s "is `AttrTag` already
   * imported" check, `exportNameFor`'s collision check): a type-only import
   * of a name still occupies it in the module, so a self-export mint or an
   * unbound-type warning must still see it.
   */
  importedNames: Set<string>;
  /** Authored import binding -> module specifier, for callee Input lookup. */
  importSpecifiers: Map<string, string>;
  /**
   * Every binding that is a *default* import whose specifier ends in
   * `.marko` or `.mx` — Marko's own statically-resolved component case
   * (`@marko/compiler` `tag-name-type.ts:174-196`; decision 116). A
   * capitalized tag bound to any other value import (a named import of any
   * source, or a default import of a `.ts`/`.js` module) lowers as a dynamic
   * tag instead of a direct call, matching Marko's own `_dynamic_tag`
   * runtime dispatch for everything that isn't this one static case.
   */
  importDefaultFromMarkoOrMx: Set<string>;
  /**
   * A file-local, non-import PascalCase binding (a `static`/module-scope
   * `const`, a `<const>`) whose value core could not statically prove is a
   * function, arrow function, or class — the local extension of decision 116
   * (firstmate's ruling under decision 116 in
   * `notes/decisions-2026-09-10.md`). A tag param is always a member of this
   * set too (its runtime value can never be inspected at lowering time); see
   * `lowerFor`/`lowerDefine`, which add every param name here alongside
   * `tagVarShadowed` rather than trying to prove them one way or the other.
   * Checked only for a `fileLocalBinding` that is neither `ctx.defines` (a
   * `<define>` call, inherently function-like) nor `ctx.importSpecifiers` (an
   * import, decision 116's own gate) — a name absent from this set kept its
   * pre-existing direct call.
   */
  unknownLocalValue: Set<string>;
  generate: (node: Node) => string;
  /** What the host declares, as `lower()` consults it (decision 79). */
  declarations: HostDeclarations;
  /** Test/integration seam until the callee Input resolver is installed. */
  calleeInputFor?: (target: import("./ir.ts").ComponentTarget) => CalleeInput;
  /** The current unit's resolved Input, for callee-side data-tag checks. */
  ownInput?: CalleeInput;
  /** Set by a dialect that resolves tags through Marko's taglib lookup. */
  lookup?: {
    /**
     * Marko's tag definition for `name`, or `undefined` when nothing resolves it.
     *
     * `template` is the absolute path of the tag's template file, which
     * Marko's own `getTagTemplate` reads from the same definition. It is set
     * by `@marko/compiler` (not by MX) for a tag found through `tags/` or a
     * `marko.json`, and is read only by a host's `resolveDiscoveredTagModule`.
     * `undefined` means the tag has no template file (an element, a host
     * taglib tag, a Marko 5 `renderer` tag).
     */
    getTag(name: string):
      | {
          taglibId?: string;
          template?: string;
          /** Marko's parse switches for the tag (`statement`: its text is code). */
          parseOptions?: { statement?: boolean };
        }
      | undefined;
  };
  /** Custom tags already discovered and loaded by the calling integration. */
  customTags?: Readonly<Record<string, CustomTag>>;
  /**
   * Per-file serial for hygienic names minted by custom tags, boxed so a
   * template context can share the *same counter* by reference (see
   * `newCtx`'s callers in `lower.ts`) rather than starting its own at zero —
   * two sibling calls, one inside a tag template and one at the call site,
   * must never mint the same serial.
   */
  customTagGensym: { n: number };
  /**
   * The name this file's default export is declared under, once lowering has
   * computed it.
   *
   * Set by `lower` before the body walk, because a self-recursive tag call
   * resolves to it *during* that walk — `bindingForTemplate` returns this
   * instead of minting an import of the file into itself (invariant §7.5-7).
   * `Ir.exportName` carries the same value onward to the host emitters.
   */
  exportName?: string;
  /**
   * This compilation emits a module with a default export.
   *
   * False for a host module **region**, which is an expression spliced into
   * someone else's module and has no `export default function` of its own.
   * It gates the export name and, through it, the self-recursion branch: a
   * region calling its own file's tag must be a positioned error, not a
   * reference to a declaration that does not exist. Set by the whole-file
   * entry points; absent means "not a module".
   */
  emitsModule?: boolean;
  /**
   * What the "is not supported in …" refusals (`rejectUnsupportedFields`) name
   * as the place being compiled; absent means `a standalone template`. A host
   * compiling an MX region inside someone else's module sets it (the JSX
   * region engine: "a `.react.mx` region"), since a region has no template
   * of its own to be "standalone". Generic opt-in; nothing host-specific.
   */
  unsupportedIn?: string;
  /** Resolved template path -> default import binding, authored or injected. */
  customTagImports?: Map<string, string>;
  /** Imports synthesized while lowering discovered template calls. */
  customTagImportNodes?: Array<Extract<IrNode, { kind: "Import" }>>;
  /**
   * The `<return>` this unit has already declared, if any.
   *
   * Only ever set while lowering a file's own top-level body, which is the
   * single legal position (design §3.3). It exists so the second `<return>`
   * is a positioned error naming the construct rather than a silent
   * last-one-wins, and it is read back into `Ir.returnValue` when the walk
   * ends.
   */
  returnValue?: { expr: Expr; loc: Position } | null;
  /**
   * How many containers deep the walk currently is, for `<return>`'s
   * unconditionality rule.
   *
   * Zero means the file's own top-level body — the only position a `<return>`
   * is legal in. Anything that makes its evaluation conditional or scoped (a
   * native element, `<if>`, `<for>`, an attribute tag, a `<define>` body, a
   * tag's content block) raises it while lowering its children, so the check
   * is one comparison instead of a parent-chain walk Marko needs because it
   * validates from a Babel path rather than during the walk.
   */
  returnDepth?: number;
  /** `package.json#mx.<target>.defaultTag` for this compile; the resolver's `configured`. */
  defaultTag?: string;
  /**
   * True while every unnamed tag of the tree being lowered has already been
   * resolved through `resolveDefaultTag`. `lower` sets it; an external
   * `lowerChildren` call finds it unset and resolves first.
   */
  unnamedTagsResolved?: boolean;
  /**
   * Every atom in the tree, in source order (decision 156), recorded by
   * `convertAtoms`; `expr()` splices each one inside an expression's span.
   */
  atoms?: Atom[];
  /** Set by `lower` once the whole template's atoms are converted. */
  atomsConverted?: boolean;
  /**
   * Every `/var` a tag call has bound so far, and where.
   *
   * `/var` binds in the call site's own scope only (invariant §7.5-8): MX
   * rejects the escape rather than emitting Marko's hoisted getter, which
   * would change the binding's user-visible type. Two reads are errors, and
   * neither is a run-time TDZ MX can afford to leave uncaught —
   * `error-custom-tag-own-body-read-before-return/` is a Marko fixture that
   * fails at run time with "Cannot access 'x' before initialization".
   *
   * Each block pre-registers its own `/var` names as `pending` before it
   * walks, and clears that flag when the walk reaches the declaring call. A
   * read that finds a `pending` binding is therefore earlier in the block
   * than the call — Marko catches the same case by comparing sibling
   * indices (`references.ts:597-602`).
   */
  tagVars?: Map<string, { block: number[]; pending: boolean }>;
  /**
   * The chain of block ids from the template body down to the block being
   * lowered, innermost last.
   *
   * Depth alone cannot answer the scope question: a read inside a sibling
   * `<p>` sits at the same depth as a binding declared inside an `<if>`, yet
   * only one of them is in scope. The path makes "is the declaring block an
   * ancestor of mine" a prefix test, which is exactly JS block scoping.
   */
  tagVarBlock?: number[];
  /**
   * Names an enclosing tag's params bind, which therefore are not a `/var`.
   *
   * `<counter/n/>` followed by `<for|n| of=xs>${n}</for>` reads the *loop's*
   * `n`, not the binding — same spelling, different variable. Maintained by
   * `shadowBindings`, which already runs at every site that binds params.
   */
  tagVarShadowed?: ReadonlySet<string>;
  /** Serial for block ids, so two sibling blocks are never confused. */
  tagVarBlockSeq?: number;
  /**
   * Positioned warnings raised during lowering: a construct that compiles but
   * drops something the author wrote.
   *
   * A sink rather than `console.warn` because the audience is an editor. A
   * warning printed to a build's stdout is invisible in the one place it
   * matters — the file being edited — and these are all silent-drop reports,
   * which is the class this codebase's guards exist to surface. The language
   * server drains this into LSP diagnostics; a plain build leaves it unset and
   * `warn()` falls back to `console.warn`, so no caller has to opt in.
   */
  warnings?: MxWarning[];
  /**
   * Per-file, per-tag stores for `analyze` / `transform` / `finalize`.
   *
   * Created by the file-level `lower()` and never by a tag template's nested
   * lower, which is why it also marks "this `Ctx` is the file root": a
   * template is expanded *into* a file, so its own lower must not run the
   * collecting hooks a second time. Cleared with the `Ctx`, so a store can
   * never leak between files, and shared by reference into a template's `Ctx`
   * so a tag called from inside a template contributes to the same file's
   * store as one called at the top level.
   */
  customTagStores?: Map<string, Map<string, unknown>>;
  /**
   * Set while the analyze pre-pass walks the body.
   *
   * The pre-pass is the ordinary walk over a scratch `Ctx`: every custom tag
   * call is lowered exactly as the real pass lowers it, so `analyze` sees the
   * identical `TagCall` the matching `transform` will see. Under this flag a
   * custom tag records its call and expands to nothing, so no hook runs, no
   * output is produced and nothing the scratch `Ctx` collected is kept.
   */
  customTagAnalyzePass?: { calls: Map<string, TagCall[]> };
  /**
   * Names of registered custom tags actually called while lowering this file.
   *
   * Only these are finalized. A package's scan registers every tag in every
   * `tags/` directory above a file, so finalizing the whole registration would
   * let a tag the file never mentions prepend nodes to it.
   */
  customTagsUsed?: Set<string>;
  /**
   * Every file the callee-`Input` resolver read while lowering this file
   * (decision 106), including followed `import type` targets.
   *
   * Written by `callee-input.ts`'s `readCalleeInput` as it resolves callees;
   * drained into `CompileResult.dependencies` so an integration (the Vite
   * plugin today, the language server in phase 4) can invalidate callers when
   * a callee's `Input` changes. Empty until lowering actually resolves a
   * callee — a file with no component calls records nothing.
   */
  dependencies?: Set<string>;
  /**
   * A tool-supplied synchronous import resolver (decision 107), tried before
   * the built-in relative/`require.resolve` resolution: tsconfig `paths`, Vite
   * `resolve.alias`. Passed through `TranslatorOptions.resolveImport`; unset
   * for every integration that has no aliases to contribute.
   */
  resolveImport?: (specifier: string, importer: string) => string | undefined;
  /**
   * The set of registered targets this compile runs under (decisions 129 and
   * 132). Required, never defaulted: core names no target and no host, so the
   * open-set questions lowering asks — which packages export the `AttrTag`
   * type, which file-kind segments exist — are answered by the caller's
   * lookup, and a missing one would silently skip a validation (accept a
   * foreign `AttrTag` import, misjudge a `.ng.mx` callee). Passed through
   * `TranslatorOptions.targets`; a host's own descriptor is the fallback its
   * compile entries default to (design note §5.1, rule (c)).
   */
  targets: TargetLookup;
}

/** One positioned warning: a compile that succeeded while dropping something. */
export interface MxWarning {
  message: string;
  line: number;
  column: number;
  file?: string;
}

/**
 * Records a positioned warning, or prints it when no sink is collecting.
 *
 * The fallback keeps a plain `compile()` call as loud as it was before the
 * sink existed; a caller that wants them (the language server) passes
 * `ctx.warnings` and publishes them instead.
 */
export function warn(ctx: Ctx, warning: MxWarning): void {
  if (ctx.warnings) {
    ctx.warnings.push(warning);
    return;
  }
  const where = warning.file ? `${warning.file}:` : "";
  console.warn(
    `${where}${warning.line}:${warning.column + 1}: ${warning.message}`,
  );
}

export function fail(message: string, node: Node, file?: string): never {
  const loc = node?.loc?.start ?? node?.start ?? { line: 0, column: 0 };
  throw new TranslateError(message, loc.line ?? 0, loc.column ?? 0, file);
}

/**
 * Marko's own failure for a tag name nothing resolves ("Unable to find
 * entry point for custom tag `<Name>`.", verified against
 * `@marko/compiler`/`marko` 5.42.5/6.3.51 — see decision 114). Every
 * Marko-parity host (`@mxlang/html`, `@mxlang/solid`, the shared preact/
 * react/hono emitter, `@mxlang/astro`) reports this exact wording through
 * its own `rejectUnknownTag` hook; exported once here so the literal string
 * lives in one place instead of being hand-copied at each call site
 * (`source-bindings-silent-parse-failure`, filed from the PR #156 review).
 */
export function unresolvedCustomTagMessage(
  name: string,
  options: UnresolvedTagOptions = {},
): string {
  const base = `Unable to find entry point for custom tag \`<${name}>\`.`;
  // A capitalized name is a component call, so the nearest in-scope binding
  // is the likeliest intent; a lowercase one is likeliest a mistyped element.
  const isComponent = /^[A-Z]/.test(name);
  const near = isComponent
    ? nearestName(name, options.candidates ?? [])
    : nearestHtmlElement(name);
  if (near) return `${base} Did you mean \`<${near}>\`?`;
  return options.hint && isComponent ? `${base} ${options.hint}` : base;
}

/** What `unresolvedCustomTagMessage` may add to Marko's wording. */
export interface UnresolvedTagOptions {
  /** In-scope component names (imports, `<define>`s) a capitalized tag may be a typo of. */
  candidates?: Iterable<string>;
  /** How the host resolves a component, shown when no candidate is near. */
  hint?: string;
}

export function quote(text: string): string {
  return JSON.stringify(text);
}

/**
 * The source text an expression node came from, printed back to code.
 *
 * Identifier references to a name the host registered in `ctx.bindings` are
 * rewritten (decision 70's binding registry): with `count` registered to
 * `count()`, `count + 1` prints `count() + 1`.
 *
 * Precision limits, all deliberate and all tested:
 *
 * - Only *reference* positions are rewritten. A member's property name
 *   (`obj.count`) and an object literal's non-shorthand key (`{ count: 1 }`)
 *   are left alone, because Babel's own `isReferencedIdentifier` says they are
 *   not references.
 * - A **declaration's own identifier never comes here at all**: `<const>`,
 *   `<define>` and `<for>` print their names through `declName()`, because a
 *   bare `Identifier` handed to this function has no parent for
 *   `isReferencedIdentifier` to judge and would be rewritten into
 *   `const count() = …`. See `declName` for that half of the rule.
 * - **Shadowing is respected.** An identifier is rewritten only when it is
 *   *free* in the expression — `path.scope.getBinding(name)` finds nothing —
 *   because a free name is what refers to the template-level binding the host
 *   registered. A parameter, `const`/`let`, or catch-clause binding of the same
 *   name inside the expression shadows it and is left alone, so
 *   `xs.map(count => count)` is untouched while `xs.map(x => x + count)` is
 *   rewritten. Both pinned in `lower.test.ts`.
 * - The walk runs only when something is registered, so a host that uses no
 *   stateful tags pays nothing.
 */
export function expr(ctx: Ctx, node: Node): string {
  const start = node.start ?? node.loc?.start.index;
  const end = node.end ?? node.loc?.end.index;

  if (typeof start !== "number" || typeof end !== "number") {
    // If we have no position, we must fall back to generation (e.g. synthetic nodes)
    return ctx.generate(
      ctx.bindings.size === 0 ? node : rewriteReferences(ctx, node),
    );
  }

  // Decision 156: each atom inside the span becomes its string literal. The
  // slice is the authored text, so the AST-level conversion alone would leave
  // `:a` in the output; the splice is what makes `code` carry `"a"`.
  const atoms = atomSplices(ctx, start, end);
  if (ctx.bindings.size === 0) {
    return atoms.length === 0
      ? ctx.source.slice(start, end)
      : spliceSource(ctx, start, end, atoms);
  }

  return rewriteReferencesSource(ctx, node, start, end, atoms);
}

type Splice = { start: number; end: number; text: string };

/** The atoms inside `[start, end)` as splices of their string literal. */
function atomSplices(ctx: Ctx, start: number, end: number): Splice[] {
  const splices: Splice[] = [];
  for (const atom of ctx.atoms ?? []) {
    if (atom.span.sourceStart < start || atom.span.sourceEnd > end) continue;
    splices.push({
      start: atom.span.sourceStart,
      end: atom.span.sourceEnd,
      text: JSON.stringify(atom.name),
    });
  }
  return splices;
}

/** `ctx.source` over `[start, end)` with every splice applied. */
function spliceSource(
  ctx: Ctx,
  start: number,
  end: number,
  splices: Splice[],
): string {
  const sorted = [...splices].sort((a, b) => a.start - b.start);
  let result = "";
  let lastEnd = start;
  for (const r of sorted) {
    result += ctx.source.slice(lastEnd, r.start);
    result += r.text;
    lastEnd = r.end;
  }
  return result + ctx.source.slice(lastEnd, end);
}

/**
 * The source text of an identifier or pattern in **binding position**.
 *
 * Never rewritten, whatever is registered. `<const/count=…>`, `<for|count|>`
 * and `<define/Row|count|>` all print a name the emitted JS is about to
 * *declare*, and a rewrite there produces `const count() = …` — invalid JS
 * with no diagnostic, the S8 silent-wrong-output class this file's guards
 * exist to close. `expr()` cannot tell the two apart on its own: a bare
 * `Identifier` handed to it has no parent for Babel's
 * `isReferencedIdentifier()` to judge, so the caller has to say which it
 * meant, and every declaration site says it by calling this.
 *
 * A declaration also **shadows** the host's binding for the rest of its scope,
 * exactly as a parameter inside an expression does (see `expr()`): the
 * declaration site unregisters the name, so later references print plain. That
 * keeps one rule — "a name bound in the emitted JS is that binding, not the
 * host's" — instead of one rule for expressions and another for templates.
 */
export function declName(ctx: Ctx, node: Node): string {
  return ctx.generate(node);
}

/**
 * Unregisters every name a binding pattern introduces, returning an undo.
 *
 * A `<const>` shadows for the rest of the render scope and never undoes; a tag
 * param shadows for its block and is restored after, which is what the undo is
 * for.
 */
/**
 * Snapshots the whole binding registry, returning a restore for the scope.
 *
 * `shadowBindings` only undoes the names it was handed, which is right for a
 * parameter list but wrong for a *block*: a `<const>` inside an `<if>` branch
 * unregisters its own name for the rest of the render (deliberately — it is a
 * real JS `const` from there on), and without a snapshot that unregistration
 * escapes the branch it was written in. Emitted JS scoping is per block, so
 * the registry has to be too: a name shadowed inside one branch is the host's
 * binding again after it.
 *
 * Also snapshots `ctx.tagVarShadowed` for the same reason (decision 113 round
 * 2): a `<const>` inside an `<if>` branch permanently *replaces*
 * `ctx.tagVarShadowed` (it never calls its own `shadowBindings` restore, by
 * design — a `<const>` shadows for the rest of the render), so without this a
 * `<const/Panel=…/>` written inside one `<if>` branch would shadow a
 * registered `Panel` custom tag for the rest of the file, past the branch it
 * was declared in. Every scope wrapper that calls `scopeBindings` (`<if>`
 * branches, `<for>`, `<define>`, attribute-tag blocks, `<try>`) gets this for
 * free, so the revert is structural rather than a per-construct fix.
 */
export function scopeBindings(ctx: Ctx): () => void {
  const saved = ctx.bindings.snapshot();
  const savedShadowed = ctx.tagVarShadowed;
  return () => {
    ctx.bindings.restore(saved);
    ctx.tagVarShadowed = savedShadowed;
  };
}

export function shadowBindings(ctx: Ctx, names: string[]): () => void {
  const saved: Array<[string, BindingRewrite]> = [];
  for (const name of names) {
    const rewrite = ctx.bindings.get(name);
    if (!rewrite) continue;
    saved.push([name, rewrite]);
    ctx.bindings.unregister(name);
  }
  // Every shadowed name is recorded, not only the host-registered ones the
  // loop above had something to unregister. A plain `<for|n|>` registers no
  // rewrite at all, yet `n` inside that body is the loop's parameter — so a
  // `/var` of the same spelling is not what the body reads, and
  // `checkTagVarReads` has to know that (round 1, finding 4).
  const outerShadowed = ctx.tagVarShadowed;
  if (names.length > 0) {
    ctx.tagVarShadowed = new Set([...(outerShadowed ?? []), ...names]);
  }
  return () => {
    for (const [name, rewrite] of saved) ctx.bindings.register(name, rewrite);
    ctx.tagVarShadowed = outerShadowed;
  };
}

/**
 * Returns the source text with registered identifier references replaced.
 *
 * Slicing the text (rather than returning a rewritten Babel node to be printed)
 * is what preserves TypeScript type arguments: Marko's parser drops them from the
 * AST, so a generated node would be missing them, while the original source text
 * retains them exactly as authored.
 */
function rewriteReferencesSource(
  ctx: Ctx,
  node: Node,
  exprStart: number,
  exprEnd: number,
  atoms: Splice[] = [],
): string {
  // A bare identifier is never "referenced" as a lone expression to traverse
  // (there is no parent to ask), so it is handled before the walk.
  if (node.type === "Identifier") {
    const rewrite = ctx.bindings.get(node.name);
    return rewrite ? rewrite(node.name) : ctx.source.slice(exprStart, exprEnd);
  }

  const { types, traverse } = markoBabel();
  // `traverse` needs a Program to walk, and these nodes came out of Marko's
  // own Babel instance, so its bundled traverse is the one that knows them.
  const file = types.file(
    types.program([types.expressionStatement(node as Node)]),
  );

  // Atoms are spliced together with the binding rewrites (decision 156): an
  // atom is never an identifier, so the two never overlap.
  const rewrites: Splice[] = [...atoms];
  // Set only when a reference that *would* be rewritten has no position to
  // splice at — never cleared, so one such reference anywhere in the tree
  // forces the AST-clone fallback below rather than a silent partial rewrite
  // (decision 65's "no silent drop": a matched-but-unspliceable identifier
  // must not just keep its original, un-rewritten name in the output).
  let unpositionedMatch = false;

  traverse(file, {
    // biome-ignore lint/style/useNamingConvention: a Babel visitor key is a node type
    Identifier(path: Node) {
      if (!path.isReferencedIdentifier()) return;
      const rewrite = ctx.bindings.get(path.node.name);
      if (!rewrite) return;
      // A name bound *inside* the expression is not the host's binding: an
      // arrow's parameter, a `const`, a catch clause. `getBinding` walks the
      // scope chain up to the Program this walk built, so a hit means the
      // author shadowed the name here and a miss means the name is free —
      // which is exactly when it refers to the template-level binding the host
      // registered. Rewriting a shadow would emit `xs.map(count => count())`,
      // calling the parameter.
      if (path.scope.getBinding(path.node.name)) return;

      const pathStart = path.node.start ?? path.node.loc?.start.index;
      const pathEnd = path.node.end ?? path.node.loc?.end.index;
      if (typeof pathStart === "number" && typeof pathEnd === "number") {
        rewrites.push({
          start: pathStart,
          end: pathEnd,
          text: rewrite(path.node.name),
        });
      } else {
        unpositionedMatch = true;
      }
    },
  });

  // No real-positioned expression node has been observed to contain a
  // position-less identifier (the one synthetic node this printer documents,
  // an attribute method's whole `FunctionExpression`, has no position at
  // *any* level, so `expr()`'s outer check routes it to `rewriteReferences`
  // before this function is ever entered) — but nothing here depends on that
  // staying true, so a future synthetic-node shape is a loud AST reprint
  // instead of a silently wrong splice.
  if (unpositionedMatch) {
    return ctx.generate(rewriteReferences(ctx, node));
  }

  if (rewrites.length === 0) {
    return ctx.source.slice(exprStart, exprEnd);
  }

  return spliceSource(ctx, exprStart, exprEnd, rewrites);
}

/**
 * Fallback node rewriter for synthetic nodes (which lack `start`/`end`).
 */
function rewriteReferences(ctx: Ctx, node: Node): Node {
  const { types, traverse, parseExpression } = markoBabel();
  const clone = types.cloneNode(node, true);
  if (clone.type === "Identifier") {
    const rewrite = ctx.bindings.get(clone.name);
    return rewrite ? parseExpression(rewrite(clone.name)) : clone;
  }
  const file = types.file(
    types.program([types.expressionStatement(clone as Node)]),
  );
  traverse(file, {
    // biome-ignore lint/style/useNamingConvention: a Babel visitor key is a node type
    Identifier(path: Node) {
      if (!path.isReferencedIdentifier()) return;
      const rewrite = ctx.bindings.get(path.node.name);
      if (!rewrite) return;
      if (path.scope.getBinding(path.node.name)) return;
      path.replaceWith(parseExpression(rewrite(path.node.name)));
      path.skip();
    },
  });
  return file.program.body[0].expression;
}

/**
 * The statement's own source text.
 *
 * `import`/`static`/`export` arrive as tags whose attributes are word soup and
 * whose `start`/`end` are undefined; only `loc` spans the statement, so the
 * text is recovered by line/column and handed back to a real JS parser.
 */
export function sliceLoc(ctx: Ctx, loc: Node): string {
  const { start, end } = loc;
  if (start.line === end.line) {
    return (ctx.lines[start.line - 1] ?? "").slice(start.column, end.column);
  }
  const first = (ctx.lines[start.line - 1] ?? "").slice(start.column);
  const middle = ctx.lines.slice(start.line, end.line - 1);
  const last = (ctx.lines[end.line - 1] ?? "").slice(0, end.column);
  return [first, ...middle, last].join("\n");
}

/**
 * The local binding names an `import` statement introduces — default,
 * namespace, and every named import, aliased or not. Includes a type-only
 * binding (a whole `import type` or an inline `{ type X }`): a caller
 * deciding "is this exact name already imported at all, value or type"
 * (`needsAttrTagImport`'s `ctx.importedNames.has("AttrTag")`,
 * `exportNameFor`'s collision check) needs that. `importTypeOnlyBindings`
 * below identifies the type-only subset of these same names;
 * `lowerStatement` adds every one of `importBindings`'s names to
 * `ctx.importedNames` but only the non-type-only ones to `ctx.imports`,
 * which is what every host's own `isComponent` (and this file's own
 * file-local-binding check) consults for tag-name resolution.
 *
 * Parsed rather than regex-scraped: a tag name is only a component call when it
 * names one of these bindings, so an incomplete extraction here silently
 * misroutes exactly the tags this rule exists to route (decision 47).
 */
export function importBindings(line: string): string[] {
  try {
    const file = markoBabel().parse(line, {
      sourceType: "module",
      plugins: ["typescript"],
    });
    const declaration = file.program.body[0] as Node;
    if (declaration?.type !== "ImportDeclaration") return [];
    return declaration.specifiers.map((s: Node) => s.local.name);
  } catch {
    return [];
  }
}

/**
 * The subset of `importBindings(line)` that is type-only: bound by a whole
 * `import type { X }` or an inline `{ type X }` specifier, introducing no
 * runtime value.
 *
 * A tag name resolves to a component only through a *value* binding
 * (decision 114/115) — Marko's own rule, since a type is erased before the
 * module runs and a tag referencing one would be a `ReferenceError` at
 * render time, not a component call. `lowerStatement` uses this to split
 * `importBindings`'s names between `ctx.importedNames` (every name,
 * unfiltered — what `needsAttrTagImport`'s "is `AttrTag` already imported"
 * check and `exportNameFor`'s collision check correctly want) and
 * `ctx.imports` (value bindings only — what every host's own `isComponent`,
 * and this file's own file-local-binding check, correctly want for
 * tag-name resolution). Mirrors `@mxlang/parser`'s `programBindings`, which
 * excludes the same two shapes outright for `.solid.mx` region resolution
 * (a region has no `needsAttrTagImport`-style second consumer to preserve);
 * duplicated rather than shared because core may not depend on
 * `@mxlang/parser` (see `packages/core/AGENTS.md`).
 */
export function importTypeOnlyBindings(line: string): Set<string> {
  const typeOnly = new Set<string>();
  try {
    const file = markoBabel().parse(line, {
      sourceType: "module",
      plugins: ["typescript"],
    });
    const declaration = file.program.body[0] as Node;
    if (declaration?.type !== "ImportDeclaration") return typeOnly;
    if (declaration.importKind === "type") {
      for (const s of declaration.specifiers as Node[]) {
        typeOnly.add(s.local.name);
      }
      return typeOnly;
    }
    for (const s of declaration.specifiers as Node[]) {
      if (s.importKind === "type") typeOnly.add(s.local.name);
    }
    return typeOnly;
  } catch {
    return typeOnly;
  }
}

/** One name an `import` statement brings in, and how it was written. */
export interface ImportedName {
  /**
   * The name as exported by the *module* — `useState` for both
   * `import { useState }` and `import { useState as us }`.
   *
   * `"default"` for a default import, and `"*"` for a namespace import,
   * where every export is reachable through the local object and no single
   * imported name exists.
   */
  imported: string;
  /** The binding this file refers to it by, which may be an alias. */
  local: string;
}

/**
 * What an `import` statement brings in, with its module and both names.
 *
 * `importBindings` answers only "which locals does this bind", which is all
 * tag routing needs. A caller deciding something about *what was imported* —
 * the JSX hosts' hook guard — needs the module's own spelling of the name and
 * the source it came from, and neither survives in the local binding.
 *
 * Parsed, never matched against the printed text. The statement's source may
 * be single- or double-quoted, the import may be a namespace or an alias, and
 * a substring test over the printed line got all three wrong: measured, a
 * guard written that way accepted `'preact/hooks'`, `import * as h from …`
 * and `{ useState as us }` alike.
 */
export function importedNames(
  line: string,
): { source: string; names: ImportedName[] } | null {
  try {
    const file = markoBabel().parse(line, { sourceType: "module" });
    const declaration = file.program.body[0] as Node;
    if (declaration?.type !== "ImportDeclaration") return null;
    const source = declaration.source?.value;
    if (typeof source !== "string") return null;
    return {
      source,
      names: declaration.specifiers.map((specifier: Node) => ({
        imported:
          specifier.type === "ImportDefaultSpecifier"
            ? "default"
            : specifier.type === "ImportNamespaceSpecifier"
              ? "*"
              : // A string-literal specifier (`import { "a-b" as ab }`) has a
                // `value` rather than a `name`.
                (specifier.imported?.name ?? specifier.imported?.value ?? ""),
        local: specifier.local?.name ?? "",
      })),
    };
  } catch {
    return null;
  }
}

/**
 * Whether a module specifier names a `.marko`/`.mx` template file.
 *
 * The one fact decision 116's routing turns on: a *default* import from a
 * `.marko`/`.mx` source is Marko's own statically-resolved component case
 * (`@marko/compiler` `tag-name-type.ts:174-196`); every other value import —
 * named, namespace, or a default from a `.ts`/`.js`/anything-else module —
 * lowers as a dynamic tag instead of a direct call, matching Marko's own
 * `_dynamic_tag` runtime dispatch. Exported so every consumer checking "is
 * this specifier a template file" (`lower.ts`'s own `import` handling, and
 * `@mxlang/parser`'s module-scope scan for `.solid.mx`) shares one rule
 * rather than duplicating the extension test.
 */
export function isMarkoOrMxSpecifier(specifier: string): boolean {
  return /\.(?:marko|mx)$/.test(specifier);
}

/**
 * Whether an expression node is one core can prove, at lowering time, always
 * evaluates to a function/class value — the local extension of decision 116
 * (firstmate's ruling: `function Foo(){}`/`class Foo{}` stay a direct call;
 * `const Foo = lazy(...)` or any other opaque expression is "unknown" and
 * lowers dynamic). Deliberately narrow: no alias-chasing through another
 * identifier, no evaluating a call's return shape — those are exactly the
 * "unknown" cases the ruling calls out. `node` is a Babel expression/
 * declaration node (from `markoBabel()`'s parse of a `static` line, or a
 * `<const>`'s raw value node before `exprOf`), not core's own `Expr`.
 */
export function isFunctionLikeValue(node: Node | null | undefined): boolean {
  switch (node?.type) {
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ClassExpression":
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return true;
    default:
      return false;
  }
}

/**
 * True when a child list holds anything that renders (decision 141).
 * Marko's parser has already normalized text: a retained space is content,
 * while dropped newline indentation creates no node. Never trim it again.
 */
export function hasContent(children: Node[]): boolean {
  return children.some((child: Node) => {
    if (child.type === "MarkoComment") return false;
    if (child.type === "MarkoText") return child.value !== "";
    return true;
  });
}

/**
 * `<button (click)="go()">`: Angular's event binding reads, in Marko, as tag
 * arguments `(click)` plus a default attribute value. A host that renders
 * event handlers (the one that declares `resolveAttributeMethod`) takes the
 * Marko spelling `onClick=go`; one that does not (`@mxlang/html`) has no form
 * to suggest, so the message stays as it was.
 */
function eventHandlerHint(ctx: Ctx, node: Node): string {
  const args: Node[] | undefined = node.arguments;
  const event =
    args?.length === 1 && args[0]?.type === "Identifier"
      ? args[0].name
      : undefined;
  if (
    !event ||
    ctx.declarations.resolveAttributeMethod?.(node, "element") !== true
  ) {
    return "";
  }
  const value: Node | undefined = node.attributes?.find(
    (attr: Node) => attr.default,
  )?.value;
  const handler =
    value?.type === "Identifier"
      ? value.name
      : value?.type === "StringLiteral"
        ? /^\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*$/.exec(value.value)?.[1]
        : undefined;
  return `; for an event handler write \`on${event[0].toUpperCase()}${event.slice(1)}=${handler ?? "handler"}\``;
}

/** The place {@link rejectUnsupportedFields} names; see `Ctx.unsupportedIn`. */
function unsupportedIn(ctx: Ctx): string {
  return ctx.unsupportedIn ?? "a standalone template";
}

/**
 * Rejects the node fields this translator does not read.
 *
 * Marko's parser fills in more than the string target lowers: attribute tags,
 * tag arguments, a tag variable and type arguments are all separated out of
 * the body at parse time, so a path that walks only `body.body` renders none
 * of them and reports nothing. That is the silent-drop failure S8 exists to
 * close — the same class as `by=`, and worse, because whole authored content
 * disappears from a successful compile.
 *
 * One guard rather than a check per emission path: seven scattered copies
 * would drift, and the next field Marko adds would be dropped by whichever
 * copy was forgotten.
 *
 * `allow` names the fields the calling path genuinely lowers — only a
 * component call reads `attributeTags`, and only `<define>`/`<const>` read
 * `var`. An *inert* field is declared here too rather than ignored: decision
 * 65 accepts a construct with no output effect, but the guard still has to
 * know it was considered, or the next silently-dropped field looks exactly
 * like an intentionally inert one.
 */
export function rejectUnsupportedFields(
  ctx: Ctx,
  node: Node,
  what: string,
  allow: {
    attributeTags?: boolean;
    var?: boolean;
    params?: boolean;
    args?: boolean;
  } = {},
): void {
  if (!allow.attributeTags && node.attributeTags?.length) {
    const first = node.attributeTags[0];
    const tagName = String(first?.name?.value ?? "@…").replace(/^@/, "");
    fail(
      `attribute tag \`@${tagName}\` on ${what}; attribute tags are props of components, so they are only valid directly inside a component call`,
      first ?? node,
    );
  }
  if (!allow.args && node.arguments) {
    // Marko reports at the **argument** (`assertNoArgs`: `args[0].loc.start`,
    // `args.at(-1).loc.end`) — `<button (click)="go()">` puts the caret under
    // `click`, not under `<button`. Reporting at the tag points at the tag name
    // for an error about the arguments next to it.
    fail(
      `tag arguments \`(...)\` on ${what} are not supported in ${unsupportedIn(ctx)}${eventHandlerHint(ctx, node)}`,
      node.arguments[0] ?? node,
    );
  }
  if (!allow.var && node.var) {
    fail(
      `tag variable \`/${expr(ctx, node.var)}\` on ${what} is not supported in ${unsupportedIn(ctx)}`,
      node,
    );
  }
  if (node.typeArguments || node.body?.typeParameters) {
    fail(
      `type arguments on ${what} are not supported in ${unsupportedIn(ctx)}`,
      node,
    );
  }
  if (!allow.params && node.body?.params?.length) {
    fail(
      `tag params \`|...|\` on ${what} are not supported in ${unsupportedIn(ctx)}`,
      node,
    );
  }
}

/**
 * Enforces that an inert tag appears in the shape its own definition allows.
 *
 * A tag is inert because *it* emits nothing, not because anything written
 * inside it may be thrown away. `<effect><div>x</div></effect>` compiled clean
 * with the `<div>` gone before this existed — a successful compile that
 * silently deleted authored markup, which is the exact failure class (S8) the
 * field guard was built to close.
 *
 * The declared shapes come from each tag's own Marko definition, and the
 * outcomes match what Marko itself does: `<effect>` with a body is
 * "does not support body content" there, an unknown attribute is "does not
 * support the `foo` attribute", and `<lifecycle>`/`<id>`/`<log>`/`<debug>` are
 * `openTagOnly` so a body is a parse error before any translator sees it.
 */
export function rejectInertShape(
  ctx: Ctx,
  node: Node,
  name: string,
  disposition: Extract<Disposition, { kind: "inert" }>,
): void {
  rejectUnsupportedFields(ctx, node, `\`<${name}>\``, {
    params: true,
    args: true,
    var: true,
  });

  for (const attr of node.attributes ?? []) {
    if (attr.type === "MarkoSpreadAttribute") {
      fail(
        `spread attributes on \`<${name}>\` are not supported: the tag emits nothing, so a spread's keys would be silently discarded`,
        attr,
      );
    }
    if (disposition.attributes !== "none") continue;
    // A control tag's own value attribute (`<log=x/>`) is spelled `value` or
    // marked `default` by the parser depending on the form; either way it is
    // the tag's own argument, not an extra. An `effect() { … }` body arrives
    // as an attribute with `arguments`, which is likewise the tag's own.
    if (attr.name === "value" || attr.default || attr.arguments) continue;
    fail(
      `\`<${name}>\` does not support the \`${attr.name}\` attribute; it emits nothing, so the attribute would be silently discarded`,
      attr,
    );
  }

  if (disposition.body === "text") return;
  if (hasContent(node.body?.body ?? [])) {
    fail(
      `\`<${name}>\` does not support body content; it emits nothing, so the body would be silently discarded`,
      node,
    );
  }
}

export function attrByName(node: Node, name: string): Node | undefined {
  return (node.attributes ?? []).find(
    (a: Node) => a.type === "MarkoAttribute" && a.name === name,
  );
}

export function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);
}

/**
 * Every name a binding pattern declares.
 *
 * Destructuring included, since `<const/{a, b}=…>` declares both and each
 * shadows the host's binding of that name.
 */
export function bindingIdentifiers(pattern: Node): string[] {
  return bindingIdentifierNodes(pattern).map((node) => node.name);
}

/** `bindingIdentifiers`, as the `Identifier` nodes, so a caller can position each. */
export function bindingIdentifierNodes(pattern: Node): Node[] {
  if (!pattern || typeof pattern !== "object") return [];
  switch (pattern.type) {
    case "Identifier":
      return [pattern];
    case "ObjectPattern":
      return (pattern.properties ?? []).flatMap((property: Node) =>
        bindingIdentifierNodes(property.value ?? property.argument),
      );
    case "ArrayPattern":
      return (pattern.elements ?? []).flatMap((element: Node) =>
        bindingIdentifierNodes(element),
      );
    case "AssignmentPattern":
      return bindingIdentifierNodes(pattern.left);
    case "RestElement":
      return bindingIdentifierNodes(pattern.argument);
    default:
      return [];
  }
}

/**
 * The name `isDelegatedTag` receives for a dynamic tag (`<${expr}/>`).
 *
 * A sentinel rather than a real tag name, so it can never collide with a
 * name an author wrote. Exported so that declarations match the same value the
 * core passes: two hand-typed copies of a sentinel is exactly the drift that
 * makes one side silently stop matching.
 */
export const DYNAMIC_TAG = "\u0000dynamic";
/**
 * A fresh lower context, with the stateful-tag hooks wired.
 *
 * Exported because fragment hosts and lowerer tests need a context without
 * going through the whole-file compiler seam.
 */
export function newCtx(
  source: string,
  generate: (node: Node) => string,
  declarations: HostDeclarations,
  lookup: Ctx["lookup"] | undefined,
  filename: string,
  targets: TargetLookup,
): Ctx {
  // Required, never defaulted: `filename` is what an injected custom-tag
  // import is made relative to. A placeholder would not fail — it would emit a
  // syntactically valid but wrong specifier (`../../../../abs/path/icon.mx`),
  // which is the silent-garbage failure a default is supposed to prevent.
  if (!filename) {
    throw new Error(
      "@mxlang/core: newCtx requires the filename being compiled; it is what an injected tag import resolves against",
    );
  }
  const rewrites = new Map<string, BindingRewrite>();
  const ctx: Ctx = {
    source,
    filename,
    lines: source.split("\n"),
    prelude: [],
    hoist(code: string, node: Node) {
      ctx.prelude.push({ code, node });
    },
    bindings: {
      register(name, rewrite) {
        rewrites.set(name, rewrite);
      },
      unregister(name) {
        rewrites.delete(name);
      },
      get(name) {
        return rewrites.get(name);
      },
      get size() {
        return rewrites.size;
      },
      snapshot() {
        return [...rewrites];
      },
      restore(saved) {
        rewrites.clear();
        for (const [name, rewrite] of saved) rewrites.set(name, rewrite);
      },
    },
    defines: new Map(),
    imports: new Set(),
    importedNames: new Set(),
    importSpecifiers: new Map(),
    importDefaultFromMarkoOrMx: new Set(),
    unknownLocalValue: new Set(),
    generate,
    declarations,
    lookup,
    targets,
    customTagGensym: { n: 0 },
  };
  return ctx;
}
