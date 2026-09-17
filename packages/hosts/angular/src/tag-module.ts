/**
 * `@mxlang/angular`'s tag-unit compiler (design note "Custom tags: a `.mx`
 * tag file becomes an Angular component", task 1.7).
 *
 * A tag file is an ordinary `.mx` file that compiles, per host, into a module
 * exporting the tag (decision 95, `notes/investigations/tag-unit-design.md`
 * §1.1). On every other host that module's default export is a function. An
 * Angular component is a class with a decorator — there is no template-only
 * form — so this host emits a real standalone component module instead, and
 * the caller references it through its selector rather than by calling it.
 */

import { readFileSync } from "node:fs";
import {
  type CompileResult,
  type Ctx,
  type CustomTag,
  compileSource,
  type Ir,
  type IrNode,
  type MxWarning,
  moduleExportName,
  type Position,
  TranslateError,
} from "@mxlang/core";
import {
  angularDeclarations,
  emitTemplate,
  isTagModuleImport,
  kebabCase,
  tagBasename,
  type UsedTag,
} from "./emitter.ts";

/** Angular directives the emitted template may need in the component's `imports:`. */
const DIRECTIVE_IMPORTS = [
  // Each entry pairs the text the emitter emits with the symbol Angular needs
  // in `imports:`. Detected from the emitted template rather than tracked
  // through the emitter, so a construct that starts emitting one of these can
  // never forget to declare it.
  { marker: "[ngClass]", symbol: "NgClass" },
  { marker: "[ngStyle]", symbol: "NgStyle" },
  { marker: "| keyvalue", symbol: "KeyValuePipe" },
  { marker: "[ngComponentOutlet]", symbol: "NgComponentOutlet" },
  { marker: "[ngTemplateOutlet]", symbol: "NgTemplateOutlet" },
] as const;

export interface CompileTagModuleOptions {
  /** Custom tags already discovered and loaded by the calling integration. */
  customTags?: Record<string, CustomTag>;
  /** Collects positioned warnings; unset, they print to `console.warn`. */
  warnings?: MxWarning[];
  /**
   * The element-name prefix for this tag, `mx.angular.tagSelectorPrefix`.
   * Defaults to `mx-`; the tag's own `export const selector` still wins.
   */
  tagSelectorPrefix?: string;
}

export interface CompileTagModuleResult extends CompileResult {
  warnings: MxWarning[];
  /** Every MX tag this tag's own template called, for its `imports:` array. */
  usedTags: UsedTag[];
  /** The component class this module exports, e.g. `UserCard`. */
  className: string;
  /** The element name the component matches, e.g. `mx-user-card`. */
  selector: string;
}

/**
 * The narrow slice of Babel's TypeScript AST this file reads.
 *
 * Deliberately structural and permissive: only the fields actually consulted
 * are named, so a Babel version bump cannot break a type this file asserts
 * about nodes it never touches.
 */
interface BabelTypeNode {
  type?: string;
  start?: number;
  end?: number;
}

interface BabelMember {
  type?: string;
  optional?: boolean;
  key?: { type?: string; name?: string };
  typeAnnotation?: { typeAnnotation?: BabelTypeNode };
}

interface BabelFile {
  program: {
    body: Array<{
      declaration?: { body?: { body?: BabelMember[] } };
      body?: { body?: BabelMember[] };
    }>;
  };
}

/** One `@Input()` derived from a property of the tag's `export interface Input`. */
interface InputProp {
  name: string;
  /** The TypeScript type, copied verbatim from the author's interface. */
  type: string;
  optional: boolean;
}

/**
 * Parses the property list of an `export interface Input { … }`.
 *
 * Babel's own TypeScript parse, through `@marko/compiler/internal/babel` —
 * the same instance `packages/core` uses, never a second Babel. Each
 * property's type is taken as the **verbatim source slice** of its type
 * annotation rather than re-printed from the AST, so the emitted `@Input()`
 * keeps the author's exact spelling.
 *
 * A text scan stood here first and was wrong in three measured ways, each a
 * silently mistyped or missing input: it dropped newline-separated properties
 * (no `;`/`,`), mis-sliced an arrow type (`(e: X) => void` — the `>` closed a
 * depth the `(` had opened), and broke on `//` or `/* *\/` comments. None of
 * those is exotic in a real interface.
 */
function parseInputProps(
  node: Extract<IrNode, { kind: "InputInterface" }>,
): InputProp[] {
  const code = node.code;
  const babel = require("@marko/compiler/internal/babel") as {
    parse(source: string, options: unknown): BabelFile;
  };

  let ast: BabelFile;
  try {
    ast = babel.parse(code, {
      sourceType: "module",
      plugins: ["typescript"],
    });
  } catch (err) {
    throw new TranslateError(
      `\`export interface Input\` could not be parsed as TypeScript: ${(err as Error).message}`,
      node.loc.line,
      node.loc.column,
      node.loc.file,
    );
  }

  const statement = ast.program.body[0];
  const declaration = statement?.declaration ?? statement;
  const members = declaration?.body?.body;
  if (!Array.isArray(members)) return [];

  const props: InputProp[] = [];
  for (const member of members) {
    // Only a named property can become an `@Input()`. A call or construct
    // signature, an index signature and a method are each reported rather
    // than skipped: silently dropping one leaves the caller passing an
    // attribute the component never declares, which Angular renders as
    // nothing — the same silent-blank class this whole pass exists to stop.
    if (member.type !== "TSPropertySignature") {
      throw new TranslateError(
        "`Input` may only declare properties on Angular",
        node.loc.line,
        node.loc.column,
        node.loc.file,
      );
    }
    const key = member.key;
    if (key?.type !== "Identifier" || typeof key.name !== "string") {
      throw new TranslateError(
        "`Input` may only declare properties on Angular",
        node.loc.line,
        node.loc.column,
        node.loc.file,
      );
    }
    const annotation = member.typeAnnotation?.typeAnnotation;
    if (
      typeof annotation?.start !== "number" ||
      typeof annotation.end !== "number"
    ) {
      throw new TranslateError(
        `\`Input.${key.name}\` needs a type annotation on Angular, which declares each \`@Input()\` with its type`,
        node.loc.line,
        node.loc.column,
        node.loc.file,
      );
    }
    props.push({
      name: key.name,
      type: code.slice(annotation.start, annotation.end),
      optional: member.optional === true,
    });
  }
  return props;
}

/**
 * The name a zero-argument `input.<name>()` interpolation reads, or null.
 *
 * This is the content/slot signal, and it is read off the IR expression's own
 * AST rather than `Ir["tagMetadata"].attributeTags`. That field is core's
 * *caller-side* warning heuristic and matches a bare `input.x` with no call
 * (`template-tag.ts`'s `inputMember`), so an ordinary string input read as
 * `${input.title}` appears in it — using it here would emit an
 * `<ng-content select="[title]">` for a plain `@Input()`. The design note's
 * rule is specifically a *read of the slot as a function*.
 */
function slotNameOf(node: IrNode): string | null {
  if (node.kind !== "Interpolation") return null;
  const ast = node.expr.node as
    | {
        type?: string;
        arguments?: unknown[];
        callee?: {
          type?: string;
          computed?: boolean;
          object?: { type?: string; name?: string };
          property?: { type?: string; name?: string };
        };
      }
    | undefined;
  if (ast?.type !== "CallExpression" || ast.arguments?.length !== 0)
    return null;
  const callee = ast.callee;
  if (callee?.type !== "MemberExpression" || callee.computed) return null;
  if (callee.object?.type !== "Identifier" || callee.object.name !== "input") {
    return null;
  }
  if (callee.property?.type !== "Identifier") return null;
  const name = callee.property.name;
  // The name reaches an emitted attribute selector, so it is checked against
  // the identifier shape rather than trusted. A non-computed member's name is
  // always an identifier in practice; this makes that an enforced invariant
  // instead of an assumption, so nothing can interpolate `"]` into the
  // selector text below.
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  return name;
}

/**
 * Rewrites every read of the tag's `input` object to the bare property name.
 *
 * On every other host a tag unit's module is a *function* taking an `input`
 * parameter, so `${input.title}` emits unchanged. An Angular component is a
 * class whose template expressions resolve against the **instance**, and each
 * declared input is a class property — so `input.title` there is a lookup of
 * property `title` on a property named `input`, which does not exist.
 *
 * Measured, and the reason this is not cosmetic: Angular's own parser accepts
 * `{{ input.title }}` and builds a `PropertyRead(PropertyRead(implicit,
 * "input"), "title")`, so it compiles clean and renders **empty** — the S8
 * silent-drop class the design note exists to prevent. `parseTemplate` cannot
 * catch it, which is why the unit tests assert the emitted expression text
 * rather than only that the template parses.
 *
 * Every *read shape* of the binding is covered, because each one that is not
 * rewritten renders blank in exactly the same silent way:
 *
 * - `input.x` (`MemberExpression`)
 * - `input?.x` (`OptionalMemberExpression` — a different node type, which is
 *   why matching on `MemberExpression` alone missed it)
 * - `input["x"]` (computed, string literal key)
 * - `input.a.b` — the *innermost* read is the binding, so the outer member is
 *   left alone and `a.b` survives as a property path on the class
 * - any of the above inside an arrow body or a call argument
 *
 * `input[k]`, with a computed non-literal key, is a positioned error: the
 * property it names is not known until run time, so there is no class member
 * to rewrite it to.
 *
 * The rewrite is on the expression AST, not its text: a regex would also hit
 * `input` inside a string literal and a member *name* (`o.input.x`).
 * Shadowing is honoured for every binder that can introduce a different
 * `input` — a `<for|input|>` tag param, a `<const/input=…>`/`<let/input=…>`
 * render-scope binding, an arrow or function parameter, and a destructuring
 * pattern that binds the name.
 */
function rewriteInputReads(body: IrNode[], ctx: Ctx): void {
  /** Does this function-like node's parameter list bind `input`? */
  const paramsBindInput = (params: unknown): boolean => {
    if (!Array.isArray(params)) return false;
    // A parameter may be a plain identifier, or any destructuring pattern
    // with the name somewhere inside it (`{ input }`, `[input]`,
    // `{ a: input = 1 }`, `...input`). Anything that binds the name shadows
    // the tag's own input, so the whole subtree is searched rather than only
    // the identifier case.
    const binds = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      if (Array.isArray(node)) return node.some(binds);
      const record = node as Record<string, unknown> & { type?: string };
      if (record.type === "Identifier" && record.name === "input") return true;
      for (const [key, child] of Object.entries(record)) {
        // A non-computed key is a property *name*, not a binding, and a
        // default value is an expression rather than a binder.
        if (key === "loc" || key === "extra" || key === "right") continue;
        if (key === "key" && record.computed !== true) continue;
        if (binds(child)) return true;
      }
      return false;
    };
    return params.some(binds);
  };

  /**
   * Does a `<define>`'s parameter list bind `input`?
   *
   * `Define.params` is **source text** (`ir.ts`), and `Define` carries no
   * `bindings` field the way `For` does, so the text is parsed into a
   * parameter list and handed to the same `paramsBindInput` scanner — a
   * define param can be a destructuring pattern (`<define/Row|{input}|>`)
   * just as a function parameter can, so a string compare would miss it.
   *
   * Parsed as an arrow's parameters rather than by splitting on commas: a
   * comma inside `{ a, b }` or a default value is not a parameter boundary.
   */
  const definesBindInput = (params: unknown): boolean => {
    if (!Array.isArray(params) || params.length === 0) return false;
    const text = params.filter((p) => typeof p === "string").join(", ");
    if (!text) return false;
    try {
      const babel = require("@marko/compiler/internal/babel") as {
        parseExpression(source: string, options?: unknown): unknown;
      };
      const arrow = babel.parseExpression(`(${text}) => 0`, {
        plugins: ["typescript"],
      }) as { params?: unknown };
      return paramsBindInput(arrow.params);
    } catch {
      // Unparseable params are the core's error to report, not this pass's.
      // Treat the name as *shadowed* on failure: leaving a read alone is the
      // safe direction — it emits what the author wrote — while rewriting one
      // that should not be is the silent-blank bug this guards.
      return true;
    }
  };

  const rewriteExpr = (
    expr: { code: string; node: unknown } | undefined,
    loc: Position,
    shadowedOuter: boolean,
  ): void => {
    if (!expr?.node) return;
    let changed = false;

    const visit = (value: unknown, shadowed: boolean): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item, shadowed);
        return;
      }
      const node = value as Record<string, unknown> & { type?: string };

      // A function introduces a scope; a parameter binding `input` shadows
      // the tag's own input object, so reads inside its body are the
      // author's binding and must be left exactly as written.
      if (
        node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionExpression" ||
        node.type === "FunctionDeclaration" ||
        node.type === "ObjectMethod" ||
        node.type === "ClassMethod"
      ) {
        const inner = shadowed || paramsBindInput(node.params);
        for (const [key, child] of Object.entries(node)) {
          if (key === "loc" || key === "extra") continue;
          visit(child, inner);
        }
        return;
      }

      if (
        !shadowed &&
        (node.type === "MemberExpression" ||
          node.type === "OptionalMemberExpression")
      ) {
        const object = node.object as { type?: string; name?: string };
        if (object?.type === "Identifier" && object.name === "input") {
          const property = node.property as {
            type?: string;
            name?: string;
            value?: unknown;
          };
          let name: string | undefined;
          if (node.computed === true) {
            // `input["x"]` is a static read spelled differently; `input[k]`
            // is not, and has no class member to resolve to.
            if (
              property?.type === "StringLiteral" &&
              typeof property.value === "string"
            ) {
              name = property.value;
            } else {
              throw new TranslateError(
                "dynamic input access is not supported on Angular",
                loc.line,
                loc.column,
                loc.file,
              );
            }
          } else if (property?.type === "Identifier") {
            name = property.name;
          }
          if (name !== undefined) {
            if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
              throw new TranslateError(
                "dynamic input access is not supported on Angular",
                loc.line,
                loc.column,
                loc.file,
              );
            }
            // Replace the whole `input.x` member with the bare identifier
            // `x`, in place. Any outer member (`input.a.b`) keeps its own
            // shape, so the result is `a.b`.
            for (const key of Object.keys(node)) delete node[key];
            node.type = "Identifier";
            node.name = name;
            changed = true;
            return;
          }
        }
      }

      for (const [key, child] of Object.entries(node)) {
        if (key === "loc" || key === "extra") continue;
        visit(child, shadowed);
      }
    };

    visit(expr.node, shadowedOuter);
    if (changed) {
      // Reprinted through the core's own generator, the same one that built
      // `code` in the first place, so spelling stays consistent.
      expr.code = ctx.generate(expr.node as Parameters<Ctx["generate"]>[0]);
    }
  };

  // Walks the IR, tracking which names the *template* has bound. A `<for>`
  // param, a `<define>` param and a `<const>`/`<let>` binding named `input`
  // each shadow the tag's own input for everything in their scope, exactly
  // as they would in the emitted template — `@for (input of …)` really does
  // rebind the name, so rewriting a read inside it would change what the
  // template means.
  const walk = (value: unknown, shadowed: boolean, loc: Position): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, shadowed, loc);
      return;
    }
    const record = value as Record<string, unknown> & { kind?: string };

    // Every `Expr` in the tree is rewritten, found by *shape* rather than by
    // a list of field names. An `Expr` is the only IR value carrying both a
    // `code` string and a `node`, so the test is exact — and unlike an
    // enumeration of `attrs`/`args`/`source.list`/`condition`/`value`, it
    // cannot silently miss a field (`<for of=input.items>` did, when this
    // walked named fields) or fall behind a new IR kind.
    if (typeof record.code === "string" && record.node) {
      rewriteExpr(
        record as unknown as { code: string; node: unknown },
        (record.loc as Position) ?? loc,
        shadowed,
      );
      return;
    }

    const here = (record.loc as Position) ?? loc;

    if (record.kind === "Const") {
      // `<const/input=…>` binds the name for everything after it, so its own
      // initializer still sees the tag's input but later siblings do not.
      // Handled by the caller's sequential pass below; here only the
      // initializer is visited.
      walk(record.init, shadowed, here);
      return;
    }

    if (record.kind === "For" || record.kind === "Define") {
      // Two IR kinds, two different sources for the same question, because
      // only `For` carries the core's own answer:
      //
      // - `For.bindings` is "every name the params bind, for a host that
      //   tracks scopes" (`ir.ts`). Its `params` beside it is *source text*,
      //   so testing that as an AST never matched and let a `<for|input|>`
      //   body be rewritten as though the tag's input were still in scope.
      // - `Define` has **no `bindings` field at all** (`ir.ts`: `name`,
      //   `params`, `children`), so reading one returned `undefined` and a
      //   `<define/Row|input|>` never shadowed — its body was rewritten to
      //   read the component while the emitted `<ng-template let-input>`
      //   bound the param, a silent wrong render.
      //
      // So `Define` is answered from its `params` text, parsed by the same
      // `paramsBindInput` scanner the function-scope case uses (a param may
      // be a destructuring pattern, not just an identifier). No core change:
      // a host tracking its own scopes is what these fields are for.
      const shadowsHere =
        record.kind === "For"
          ? Array.isArray(record.bindings) && record.bindings.includes("input")
          : definesBindInput(record.params);
      // The iterable/source is evaluated *outside* the loop's own scope, so
      // it keeps the outer meaning of `input`.
      walk(record.source, shadowed, here);
      for (const [key, child] of Object.entries(record)) {
        if (key === "loc" || key === "end" || key === "node") continue;
        if (key === "source" || key === "params") continue;
        walk(child, shadowed || shadowsHere, here);
      }
      return;
    }

    for (const [key, child] of Object.entries(record)) {
      // `node` is a parser node reached only through an `Expr` above; `loc`
      // holds positions, never expressions.
      if (key === "node" || key === "loc" || key === "end") continue;
      // A child *list* of IR nodes is a statement sequence, where a
      // `<const/input=…>` shadows only what follows it — so it is walked
      // sequentially rather than as an unordered array.
      if (Array.isArray(child) && child.some(isIrNode)) {
        walkSiblings(child as IrNode[], shadowed);
        continue;
      }
      walk(child, shadowed, here);
    }
  };

  /**
   * A sequential pass over one statement list, so a `<const/input=…>` shadows
   * the siblings after it and nothing before it — matching the emitted
   * `@let input = …`, which really does rebind the name from that point on.
   */
  function walkSiblings(nodes: IrNode[], shadowed: boolean): void {
    let scoped = shadowed;
    for (const node of nodes) {
      walk(node, scoped, node.loc);
      if (node.kind === "Const" && node.name === "input") scoped = true;
    }
  }

  walkSiblings(body, false);
}

/** Whether a value is an IR node (carries a `kind` and a position). */
function isIrNode(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

/**
 * Rewrites every `${input.slot()}` read into Angular content projection, and
 * reports the ways a slot cannot be used on this host.
 *
 * `input.content()` is the body slot (`<ng-content>`); any other name is an
 * attribute tag, which Angular matches by attribute selector
 * (`<ng-content select="[header]">`) — both probed, design note A1.
 *
 * Three misuses are errors rather than silently-wrong output, each because
 * Angular's projection is a *placement*, not a value:
 *
 * - **A repeated attribute tag.** Angular matches each selector once, so the
 *   second `<ng-content select="[x]">` renders empty.
 * - **A name read both as a slot and bare** (`${input.x()}` and `${input.x}`).
 *   One read wants a projection, the other an `@Input()`; they cannot both be
 *   true of one name, and whichever lost would render blank.
 * - **A slot called with arguments** (`${input.header(1)}`). Projection takes
 *   no parameters — the arguments would be dropped in silence.
 */
function projectSlots(body: IrNode[], ctx: Ctx): void {
  const slotLoc = new Map<string, Position>();
  const bareLoc = new Map<string, Position>();

  // First pass: every *bare* `input.x` read in the tree, so a name used both
  // ways is reported against both sites rather than whichever came first.
  const collectBare = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collectBare(item);
      return;
    }
    const record = value as Record<string, unknown> & { kind?: string };
    if (record.kind === "Interpolation" || record.kind === undefined) {
      const expr = record.expr as { node?: unknown } | undefined;
      if (expr?.node) {
        const walkAst = (node: unknown): void => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) {
            for (const item of node) walkAst(item);
            return;
          }
          const ast = node as Record<string, unknown> & { type?: string };
          // A member read whose parent is *not* a call is a bare read. The
          // call case is the slot, handled by `slotNameOf`.
          if (
            (ast.type === "MemberExpression" ||
              ast.type === "OptionalMemberExpression") &&
            ast.computed !== true
          ) {
            const object = ast.object as { type?: string; name?: string };
            const property = ast.property as { type?: string; name?: string };
            if (
              object?.type === "Identifier" &&
              object.name === "input" &&
              property?.type === "Identifier" &&
              property.name
            ) {
              const loc = record.loc as Position | undefined;
              if (loc && !bareLoc.has(property.name)) {
                bareLoc.set(property.name, loc);
              }
            }
          }
          for (const [key, child] of Object.entries(ast)) {
            if (key === "loc" || key === "extra") continue;
            // Skip a call's own callee: that read is the slot, not a bare use.
            if (
              key === "callee" &&
              (ast.type === "CallExpression" ||
                ast.type === "OptionalCallExpression")
            ) {
              continue;
            }
            walkAst(child);
          }
        };
        walkAst(expr.node);
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "node" || key === "loc" || key === "end") continue;
      collectBare(child);
    }
  };
  collectBare(body);

  const visit = (nodes: IrNode[]): void => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index] as IrNode;
      rejectSlotCallWithArgs(node);
      const slot = slotNameOf(node);
      if (slot) {
        if (slotLoc.has(slot) && slot !== "content") {
          throw new TranslateError(
            "a repeated attribute tag cannot be emitted as Angular content projection, which matches each selector once. Take the items as an input array and render them with `<for>`.",
            node.loc.line,
            node.loc.column,
            node.loc.file,
          );
        }
        const bare = bareLoc.get(slot);
        if (bare) {
          throw new TranslateError(
            `\`input.${slot}\` is read both as content (\`input.${slot}()\` at ${node.loc.line}:${node.loc.column}) and as a value (\`input.${slot}\` at ${bare.line}:${bare.column}) on Angular. Content projection is a placement, not a value — use one or the other.`,
            node.loc.line,
            node.loc.column,
            node.loc.file,
          );
        }
        slotLoc.set(slot, node.loc);
        // Substituted as a `Text` node carrying template markup rather than
        // author text (`rawTemplate`, which the emitter emits verbatim), so
        // the projection is built here — where the slot is identified — with
        // no Angular-only IR kind added to the shared core.
        nodes[index] = {
          kind: "Text",
          value:
            slot === "content"
              ? "<ng-content></ng-content>"
              : `<ng-content select="[${slot}]"></ng-content>`,
          loc: node.loc,
          rawTemplate: true,
        } as unknown as IrNode;
        continue;
      }
      for (const key of ["children", "body"] as const) {
        const children = (node as unknown as Record<string, unknown>)[key];
        if (Array.isArray(children)) visit(children as IrNode[]);
      }
      const content = (node as unknown as { content?: { children?: IrNode[] } })
        .content;
      if (content?.children) visit(content.children);
    }
  };

  visit(body);
  void ctx;
}

/**
 * A slot read called with arguments has no Angular equivalent.
 *
 * `<ng-content>` places the caller's nodes; it cannot pass them anything, so
 * the arguments would be dropped with no diagnostic.
 */
function rejectSlotCallWithArgs(node: IrNode): void {
  if (node.kind !== "Interpolation") return;
  const ast = node.expr.node as
    | {
        type?: string;
        arguments?: unknown[];
        callee?: {
          type?: string;
          computed?: boolean;
          object?: { type?: string; name?: string };
          property?: { type?: string; name?: string };
        };
      }
    | undefined;
  if (ast?.type !== "CallExpression") return;
  if (!Array.isArray(ast.arguments) || ast.arguments.length === 0) return;
  const callee = ast.callee;
  if (callee?.type !== "MemberExpression" || callee.computed) return;
  if (callee.object?.type !== "Identifier" || callee.object.name !== "input") {
    return;
  }
  const name = callee.property?.name;
  if (!name) return;
  throw new TranslateError(
    `\`input.${name}(…)\` passes arguments to content, which Angular's content projection cannot express: \`<ng-content>\` places the caller's nodes and cannot pass them values. Declare the block as a \`<define>\` and pass it as an input the component renders with \`ngTemplateOutlet\`.`,
    node.loc.line,
    node.loc.column,
    node.loc.file,
  );
}

/** Escapes a template for embedding in a double-quoted TypeScript string. */
function quoteTemplate(template: string): string {
  return JSON.stringify(template);
}

/**
 * Compiles a whole `.mx` tag file to a standalone Angular component module.
 *
 * This is the tag-unit entry point, beside `compile()`'s page-template one. A
 * *page* is the body of a `templateUrl` the user's own `.ts` owns, so its
 * module-level statements are an error there; a *tag file* is a module of its
 * own, so its `import`s and `static` blocks are **placed** at module scope
 * (tag-unit §1.5) and its `export interface Input` becomes the component's
 * `@Input()` declarations.
 */
export function compileTagModule(
  source: string,
  filename: string,
  options: CompileTagModuleOptions = {},
): CompileTagModuleResult {
  const warnings: MxWarning[] = options.warnings ?? [];
  const usedTags: UsedTag[] = [];
  const basename = tagBasename(filename);
  const prefix = options.tagSelectorPrefix ?? "mx-";
  let selector = `${prefix}${kebabCase(basename)}`;
  // Named by the core, which derives it from the basename the same way for
  // every host that emits a module (`exportNameFor`, tag-unit 2b). Set inside
  // `emitIr`, where the lowered `Ir` carrying it is in hand.
  let className = "";
  let template = "";
  let moduleLines: string[] = [];
  let inputProps: InputProp[] = [];
  const passthroughExports: string[] = [];

  const result = compileSource(source, filename, angularDeclarations, {
    customTags: options.customTags,
    warnings,
    emitIr: (ir: Ir, ctx: Ctx) => {
      className = moduleExportName(ir, "@mxlang/angular");
      // The tag's own `import`s and `static`/`export` blocks are ordinary
      // module-level statements of the emitted `.ts` — the one thing a page
      // template cannot have, and the reason a tag file is strictly easier.
      // An authored `import Child from "./child.mx"` is dropped here, not
      // emitted: the call site resolves that binding to the child's *emitted
      // module* and re-emits the import under the component class's name
      // (`usedTags`, below), so passing the author's line through as well
      // produced two imports of one component and a duplicate identifier.
      // Every other authored import is an ordinary module statement.
      const authoredImports = ir.imports.filter(
        (node) =>
          !node.synthesized &&
          !isTagModuleImport(node.specifier ?? node.code, node.resolvedPath),
      );
      moduleLines = authoredImports.map((node) => node.code);

      for (const node of ir.hoisted) {
        // `export const selector = "…"` is the tag author's own selector
        // (design note O9, RULED): the tag owns its element name, so the
        // derived default is overridable. Consumed here rather than passed
        // through, since it becomes the `@Component({ selector })` value.
        const override = node.code.match(
          /^export\s+const\s+selector\s*=\s*(["'])([^"']+)\1\s*;?\s*$/,
        );
        if (override) {
          selector = override[2] as string;
          continue;
        }
        passthroughExports.push(node.code);
      }

      if (ir.inputInterface) {
        inputProps = parseInputProps(ir.inputInterface);
        moduleLines.push(ir.inputInterface.code);
      }

      // Order matters: slot reads are `input.content()` / `input.header()`
      // calls, so they must be recognised and replaced *before* `input.` is
      // stripped off every remaining read.
      projectSlots(ir.body, ctx);
      rewriteInputReads(ir.body, ctx);
      // The page emitter builds the template, so the two kinds of output can
      // never disagree about how a construct lowers. It is handed an IR with
      // no module-level nodes, which it would otherwise reject.
      template = emitTemplate(
        {
          ...ir,
          // Both origins of a *tag module* import reach the emitter: it
          // resolves each call site's selector and import path from them.
          // Passing only the synthesized ones left an authored
          // `import Badge from "./badge.mx"` unresolved, so the call site
          // fell back to guessing `./tags/badge` — wrong from inside a
          // `tags/` directory, and not the path the author wrote.
          // An authored *non*-tag import is a plain module statement,
          // emitted above and not a component reference.
          imports: ir.imports.filter(
            (n) => n.synthesized || isTagModuleImport(n.code, n.resolvedPath),
          ),
          hoisted: [],
          inputInterface: null,
        },
        ctx,
        filename,
        usedTags,
        prefix,
        true,
      );
      return template;
    },
  });

  const directives = DIRECTIVE_IMPORTS.filter(({ marker }) =>
    template.includes(marker),
  ).map(({ symbol }) => symbol);

  // `export interface Input` is the tag-module contract's own name for the
  // props interface, so the `@Input` decorator import — always `Input` in
  // `@angular/core` — collides with it whenever there is at least one input
  // prop (`TS2440: Import declaration conflicts with local declaration`).
  // Importing it under an alias sidesteps the clash without renaming the
  // interface the author wrote.
  const angularImports = ["Component"];
  const hasInputs = inputProps.length > 0;
  if (hasInputs) angularImports.push("Input as NgInput");

  const lines: string[] = [
    `import { ${angularImports.join(", ")} } from "@angular/core";`,
  ];
  if (directives.length > 0) {
    lines.push(`import { ${directives.join(", ")} } from "@angular/common";`);
  }
  for (const tag of usedTags) {
    lines.push(
      `import ${tag.className} from ${JSON.stringify(tag.specifier)};`,
    );
  }
  if (moduleLines.length > 0) lines.push("", ...moduleLines);
  if (passthroughExports.length > 0) lines.push("", ...passthroughExports);

  const componentImports = [...directives, ...usedTags.map((t) => t.className)];
  lines.push(
    "",
    "@Component({",
    `  selector: ${JSON.stringify(selector)},`,
    "  standalone: true,",
    `  imports: [${componentImports.join(", ")}],`,
    `  template: ${quoteTemplate(template)},`,
    "})",
    `export class ${className} {`,
  );
  for (const prop of inputProps) {
    // A non-optional property is `required: true`, so Angular reports a
    // missing attribute at the call site rather than rendering `undefined`.
    const decorator = prop.optional
      ? "@NgInput()"
      : "@NgInput({ required: true })";
    // `!` on a required input: it is assigned by Angular, not the constructor,
    // which `strictPropertyInitialization` cannot see.
    const mark = prop.optional ? "?" : "!";
    lines.push(`  ${decorator} ${prop.name}${mark}: ${prop.type};`);
  }
  lines.push("}", `export default ${className};`, "");

  return {
    ...result,
    code: lines.join("\n"),
    warnings,
    usedTags,
    className,
    selector,
  };
}

/** `compileTagModule()` over a file on disk. */
export function compileTagModuleFile(
  filename: string,
  options: CompileTagModuleOptions = {},
): CompileTagModuleResult {
  return compileTagModule(readFileSync(filename, "utf8"), filename, options);
}
