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

import { createRequire } from "node:module";
import type { CustomTag, TagCall } from "./custom-tags.ts";
import type { HostDeclarations } from "./declarations.ts";
import type { IrNode } from "./ir.ts";

const require = createRequire(import.meta.url);

/**
 * Marko's own bundled Babel — parser, traverse and types in one module.
 *
 * The core parses JS in two places (an `import` statement's bindings, and an
 * expression whose identifier references a host may rewrite). Both used
 * `@mxlang/parser`'s vendored Babel while this file lived in the translator,
 * which made the string host depend on the *SolidMX parser* package for a
 * plain `parse` call. `@marko/compiler` is already this package's only
 * dependency and already bundles a full Babel, and these nodes belong to that
 * instance anyway — so the core asks it, and `@mxlang/core` depends on
 * nothing else.
 *
 * Required lazily so the type surface stays importable without pulling in a
 * 1.7MB bundle.
 */
export function markoBabel(): {
  parse: (code: string, options?: Node) => Node;
  parseExpression: (code: string, options?: Node) => Node;
  traverse: Node;
  types: Node;
  generator: (node: Node, options?: Node) => { code: string };
} {
  return require("@marko/compiler/internal/babel");
}

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
   * The file `line`/`column` are measured in, when it is not the file being
   * compiled — a diagnostic raised inside an inlined tag template.
   *
   * `undefined` for every error the compiler raises about the file it was
   * given, which is why no existing consumer had to change: only a reporter
   * that can address a second file need read it.
   */
  readonly file?: string;

  constructor(message: string, line: number, column: number, file?: string) {
    super(message);
    this.name = "TranslateError";
    this.line = line;
    this.column = column;
    this.file = file;
  }
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
  /** Local bindings introduced by the template's `import` statements. */
  imports: Set<string>;
  generate: (node: Node) => string;
  /** What the host declares, as `lower()` consults it (decision 79). */
  declarations: HostDeclarations;
  /** Set by a dialect that resolves tags through Marko's taglib lookup. */
  lookup?: { getTag(name: string): { taglibId?: string } | undefined };
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
   * False for a `.solid.mx` **region**, which is an expression spliced into
   * someone else's module and has no `export default function` of its own.
   * It gates the export name and, through it, the self-recursion branch: a
   * region calling its own file's tag must be a positioned error, not a
   * reference to a declaration that does not exist. Set by the whole-file
   * entry points; absent means "not a module".
   */
  emitsModule?: boolean;
  /** Resolved template path -> default import binding, authored or injected. */
  customTagImports?: Map<string, string>;
  /** Imports synthesized while lowering discovered template calls. */
  customTagImportNodes?: Array<Extract<IrNode, { kind: "Import" }>>;
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
  console.warn(`${where}${warning.line}:${warning.column}: ${warning.message}`);
}

export function fail(message: string, node: Node, file?: string): never {
  const loc = node?.loc?.start ?? node?.start ?? { line: 0, column: 0 };
  throw new TranslateError(message, loc.line ?? 0, loc.column ?? 0, file);
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

  if (ctx.bindings.size === 0) {
    return ctx.source.slice(start, end);
  }

  return rewriteReferencesSource(ctx, node, start, end);
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
 */
export function scopeBindings(ctx: Ctx): () => void {
  const saved = ctx.bindings.snapshot();
  return () => ctx.bindings.restore(saved);
}

export function shadowBindings(ctx: Ctx, names: string[]): () => void {
  const saved: Array<[string, BindingRewrite]> = [];
  for (const name of names) {
    const rewrite = ctx.bindings.get(name);
    if (!rewrite) continue;
    saved.push([name, rewrite]);
    ctx.bindings.unregister(name);
  }
  return () => {
    for (const [name, rewrite] of saved) ctx.bindings.register(name, rewrite);
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

  const rewrites: Array<{ start: number; end: number; text: string }> = [];
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

  rewrites.sort((a, b) => a.start - b.start);
  let result = "";
  let lastEnd = exprStart;
  for (const r of rewrites) {
    result += ctx.source.slice(lastEnd, r.start);
    result += r.text;
    lastEnd = r.end;
  }
  result += ctx.source.slice(lastEnd, exprEnd);
  return result;
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
 * namespace, and every named import, aliased or not.
 *
 * Parsed rather than regex-scraped: a tag name is only a component call when it
 * names one of these bindings, so an incomplete extraction here silently
 * misroutes exactly the tags this rule exists to route (decision 47).
 */
export function importBindings(line: string): string[] {
  try {
    const file = markoBabel().parse(line, { sourceType: "module" });
    const declaration = file.program.body[0] as Node;
    if (declaration?.type !== "ImportDeclaration") return [];
    return declaration.specifiers.map((s: Node) => s.local.name);
  } catch {
    return [];
  }
}

/** True when a child list holds anything that renders. */
export function hasContent(children: Node[]): boolean {
  return children.some((child: Node) => {
    if (child.type === "MarkoComment") return false;
    if (child.type === "MarkoText") return child.value.trim() !== "";
    return true;
  });
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
    fail(
      `tag arguments \`(...)\` on ${what} are not supported in a standalone template`,
      node,
    );
  }
  if (!allow.var && node.var) {
    fail(
      `tag variable \`/${expr(ctx, node.var)}\` on ${what} is not supported in a standalone template`,
      node,
    );
  }
  if (node.typeArguments || node.body?.typeParameters) {
    fail(
      `type arguments on ${what} are not supported in a standalone template`,
      node,
    );
  }
  if (!allow.params && node.body?.params?.length) {
    fail(
      `tag params \`|...|\` on ${what} are not supported in a standalone template`,
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
  if (!pattern || typeof pattern !== "object") return [];
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return (pattern.properties ?? []).flatMap((property: Node) =>
        bindingIdentifiers(property.value ?? property.argument),
      );
    case "ArrayPattern":
      return (pattern.elements ?? []).flatMap((element: Node) =>
        bindingIdentifiers(element),
      );
    case "AssignmentPattern":
      return bindingIdentifiers(pattern.left);
    case "RestElement":
      return bindingIdentifiers(pattern.argument);
    default:
      return [];
  }
}

/**
 * The name `claimsTag` receives for a dynamic tag (`<${expr}/>`).
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
    generate,
    declarations,
    lookup,
    customTagGensym: { n: 0 },
  };
  return ctx;
}
