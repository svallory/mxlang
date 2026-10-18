/**
 * `@mxlang/host-angular`'s tag-unit compiler (design note "Custom tags: a `.mx`
 * tag file becomes an Angular component", task 1.7).
 *
 * A tag file is an ordinary `.mx` file that compiles, per host, into a module
 * exporting the tag (`notes/investigations/tag-unit-design.md` §1.1). On
 * every other host that module's default export is a function. An Angular
 * component is a class with a decorator — there is no template-only form — so
 * this host emits a real standalone component module instead, and the caller
 * references it through its selector rather than by calling it.
 */

import { readFileSync } from "node:fs";
import * as babelParser from "@babel/parser";
import {
  type CompileResult,
  type Ctx,
  type CustomTag,
  cloneIr,
  type Expr,
  type HostDeclarations,
  type Ir,
  type IrNode,
  type MxWarning,
  moduleExportName,
  type Position,
  type TargetLookup,
  TranslateError,
  warn,
} from "@mxlang/core";
import { directivesFor } from "./directives.ts";
import {
  angularDeclarations,
  type DynamicComponentData,
  emitTemplate,
  HELPER_ADVICE_CODES,
  helperMembersFor,
  isTagModuleImport,
  kebabCase,
  returnRefusal,
  selectorDeclarationOf,
  tagBasename,
  type UsedTag,
  unreadableSelectorMessage,
} from "./emitter.ts";
import {
  type AngularMapping,
  encodeMappings,
  templateMappingsToModule,
} from "./mapping.ts";
import { angularOwnTargets } from "./own-targets.ts";
import { compileSourceWithHint } from "./structural-attr-hint.ts";

export interface CompileTagModuleOptions {
  /** Custom tags already discovered and loaded by the calling integration. */
  customTags?: Record<string, CustomTag>;
  /** `package.json#mx.angular-template.defaultTag`, already validated. */
  defaultTag?: string;
  /** Collects positioned warnings; unset, they print to `console.warn`. */
  warnings?: MxWarning[];
  /**
   * The element-name prefix for this tag, `mx.angular.tagSelectorPrefix`.
   * Defaults to `mx-`; the tag's own `export const selector` still wins.
   */
  tagSelectorPrefix?: string;
  /**
   * The registered targets this compile runs under.
   * Defaults to this package's own descriptor, which is right for a direct
   * entry; a tool compiling several targets passes the built-in registry's
   * lookup, so a callee importing `AttrTag` from another registered target's
   * package reads the same as it does today.
   */
  targets?: TargetLookup;
}

export interface CompileTagModuleResult extends CompileResult {
  warnings: MxWarning[];
  /** Every MX tag this tag's own template called, for its `imports:` array. */
  usedTags: UsedTag[];
  /** The component class this module exports, e.g. `UserCard`. */
  className: string;
  /** The element name the component matches, e.g. `mx-user-card`. */
  selector: string;
  /**
   * Mappings from the emitted module back to the `.mx` source, generated
   * offsets relative to `code` — the whole module, not the template alone.
   *
   * The template is embedded as a quoted TypeScript string, so the emitter's
   * own template-relative offsets are rebased onto the module here. A run
   * whose quoted form differs from its raw form (one containing a quote or a
   * backslash) is dropped rather than mapped to a span that would slice the
   * wrong bytes — see `templateMappingsToModule`.
   */
  mappings: AngularMapping[];
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

/**
 * A binding-position node, as `collectAuthoredIdentifiers` walks it. Same
 * permissive shape as `BabelTypeNode` above and for the same reason.
 */
interface BabelNode {
  type?: string;
  name?: string;
  id?: BabelNode;
  local?: BabelNode;
  left?: BabelNode;
  value?: BabelNode;
  argument?: BabelNode;
  elements?: Array<BabelNode | undefined | null>;
  properties?: BabelNode[];
  declarations?: BabelNode[];
  specifiers?: BabelNode[];
  declaration?: BabelNode;
  body?: BabelNode | BabelNode[];
  /** `const enum`, and `declare` on an ambient declaration. */
  const?: boolean;
  /** `let` / `var` / `const` on a `VariableDeclaration`. */
  kind?: string;
  /** `type` on `import type …` and on an `import { type X }` specifier. */
  importKind?: string;
}

interface BabelFile {
  program: {
    body: Array<
      BabelNode & {
        declaration?: BabelNode & { body?: { body?: BabelMember[] } };
        body?: { body?: BabelMember[] };
      }
    >;
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
 * Every top-level identifier the given module-level statements bind.
 *
 * Parsed with `@babel/parser` — the parser the rest of this file uses —
 * rather than scanned as text: an emitted alias is
 * only correct if the set is, and a regex over `import`/`export` lines misses
 * a destructuring pattern, a multi-declarator `const`, and an aliased named
 * import, each of which binds a name that can collide.
 *
 * A statement that fails to parse contributes nothing rather than throwing:
 * these lines are the author's own and are emitted verbatim either way, so a
 * parse failure here would report a confusing error against code that is
 * about to be handed to `tsc`, which reports it properly.
 */
function collectAuthoredIdentifiers(statements: string[]): Set<string> {
  return new Set(collectModuleBindings(statements).keys());
}

/**
 * What a module-level name is, for a template that reads it through a class
 * member: `mutable` (`let`, `var`) can be reassigned by the module's own code,
 * `value` (`const`, a function, a class, an enum, a value import) cannot, and
 * `type` (an interface, a type alias, a type-only import) has no run-time
 * value to read, and neither has a `constEnum`: TypeScript inlines its members,
 * so a class member returning it is an error.
 */
type ModuleBindingKind = "mutable" | "value" | "type" | "constEnum";

/**
 * Every top-level identifier the given module-level statements bind, with its
 * kind. Parsed, not scanned: see `collectAuthoredIdentifiers`.
 */
function collectModuleBindings(
  statements: string[],
): Map<string, ModuleBindingKind> {
  const names = new Map<string, ModuleBindingKind>();
  if (statements.length === 0) return names;

  const babel = babelParser as unknown as {
    parse(source: string, options: unknown): BabelFile;
  };

  let ast: BabelFile;
  try {
    ast = babel.parse(statements.join("\n"), {
      sourceType: "module",
      plugins: ["typescript"],
    });
  } catch {
    return names;
  }

  /** Collects every name a binding pattern introduces. */
  const fromPattern = (
    node: BabelNode | undefined | null,
    kind: ModuleBindingKind,
  ): void => {
    if (!node) return;
    switch (node.type) {
      case "Identifier":
        if (node.name) names.set(node.name, kind);
        return;
      case "ObjectPattern":
        for (const prop of node.properties ?? []) {
          fromPattern(
            prop.type === "RestElement" ? prop.argument : prop.value,
            kind,
          );
        }
        return;
      case "ArrayPattern":
        for (const el of node.elements ?? []) fromPattern(el, kind);
        return;
      case "RestElement":
      case "AssignmentPattern":
        fromPattern(node.argument ?? node.left, kind);
        return;
      default:
        return;
    }
  };

  /** Does a namespace declare anything but types? */
  const isInstantiated = (node: BabelNode): boolean => {
    const block = node.body as BabelNode | undefined;
    const statements = Array.isArray(block?.body) ? block.body : [];
    return statements.some((statement) => {
      const inner =
        statement.type === "ExportNamedDeclaration"
          ? (statement.declaration ?? statement)
          : statement;
      return (
        inner.type !== "TSInterfaceDeclaration" &&
        inner.type !== "TSTypeAliasDeclaration"
      );
    });
  };

  /** Collects the `var` declarations under a block, not entering functions. */
  const hoistedVars = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) hoistedVars(item);
      return;
    }
    const record = node as BabelNode & Record<string, unknown>;
    if (
      record.type === "FunctionDeclaration" ||
      record.type === "FunctionExpression" ||
      record.type === "ArrowFunctionExpression" ||
      record.type === "ClassDeclaration" ||
      record.type === "ClassExpression"
    ) {
      return;
    }
    if (record.type === "VariableDeclaration" && record.kind === "var") {
      for (const decl of record.declarations ?? []) {
        fromPattern(decl.id, "mutable");
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "loc" || key === "extra") continue;
      hoistedVars(child);
    }
  };

  for (const statement of ast.program.body ?? []) {
    // `export const x = 1` / `export function f()` bind through `declaration`.
    const node =
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
        ? (statement.declaration ?? statement)
        : statement;

    switch (node.type) {
      case "ImportDeclaration":
        for (const spec of node.specifiers ?? []) {
          fromPattern(
            spec.local,
            node.importKind === "type" || spec.importKind === "type"
              ? "type"
              : "value",
          );
        }
        break;
      case "VariableDeclaration":
        for (const decl of node.declarations ?? []) {
          fromPattern(decl.id, node.kind === "const" ? "value" : "mutable");
        }
        break;
      case "FunctionDeclaration":
      case "ClassDeclaration":
        fromPattern(node.id, "value");
        break;
      case "TSEnumDeclaration":
        fromPattern(node.id, node.const === true ? "constEnum" : "value");
        break;
      case "TSModuleDeclaration":
        // A namespace holding only types has no run-time value.
        if (node.id?.type === "Identifier" && isInstantiated(node)) {
          fromPattern(node.id, "value");
        }
        break;
      case "BlockStatement":
        // A block that stayed a block (`static { … } { … }`: the body is more
        // than one block, so none unwraps): a `var` hoists out of it to
        // module scope. A `let`/`const` in it stays inside the braces.
        hoistedVars(node);
        break;
      case "TSInterfaceDeclaration":
      case "TSTypeAliasDeclaration":
        fromPattern(node.id, "type");
        break;
      default:
        break;
    }
  }
  return names;
}

/** `Name` -> `MxName`, then `MxName2`… until it clears `taken`. */
function uniqueName(base: string, taken: ReadonlySet<string>): string {
  const prefixed = `Mx${base}`;
  if (!taken.has(prefixed)) return prefixed;
  for (let i = 2; ; i++) {
    const candidate = `${prefixed}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Parses the property list of an `export interface Input { … }`.
 *
 * Babel's own TypeScript parse (`@babel/parser`, the parser `packages/core`
 * uses too). Each
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
  const babel = babelParser as unknown as {
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

interface ExpressionNode {
  type?: string;
  name?: string;
  value?: unknown;
  computed?: boolean;
  object?: ExpressionNode;
  property?: ExpressionNode;
  callee?: ExpressionNode;
  arguments?: unknown[];
  [key: string]: unknown;
}

function isMember(node: ExpressionNode | undefined): node is ExpressionNode {
  return (
    node?.type === "MemberExpression" ||
    node?.type === "OptionalMemberExpression"
  );
}

/** A direct `input.name`/`input?.name` read, optionally accepting `input["name"]`. */
function inputMemberName(
  node: ExpressionNode | undefined,
  computed = false,
): string | null {
  if (!isMember(node) || node?.object?.type !== "Identifier") return null;
  if (node.object.name !== "input") return null;
  if (node.computed) {
    return computed &&
      node.property?.type === "StringLiteral" &&
      typeof node.property.value === "string"
      ? node.property.value
      : null;
  }
  const name = node.property?.type === "Identifier" ? node.property.name : null;
  return name && /^[A-Za-z_$][\w$]*$/.test(name) ? name : null;
}

/** The `name` in `input.name.content`, including optional-member spellings. */
function contentMemberName(node: ExpressionNode | undefined): string | null {
  if (!isMember(node) || node?.computed) return null;
  if (
    node.property?.type !== "Identifier" ||
    node.property.name !== "content"
  ) {
    return null;
  }
  return inputMemberName(node.object);
}

/** `${input.x()}` / `${input.x.content()}`, including optional chains. */
function calledSlotName(expr: Expr): string | null {
  const ast = expr.node as ExpressionNode | undefined;
  if (
    (ast?.type !== "CallExpression" &&
      ast?.type !== "OptionalCallExpression") ||
    ast.arguments?.length !== 0
  ) {
    return null;
  }
  return contentMemberName(ast.callee) ?? inputMemberName(ast.callee);
}

/** The named projection rendered by one interpolation idiom, or null. */
function slotNameOf(node: IrNode): string | null {
  return node.kind === "Interpolation" ? calledSlotName(node.expr) : null;
}

/** `<${input.x}/>` / `<${input.x.content}/>`, including optional chains. */
function dynamicSlotNameOf(node: IrNode): string | null {
  if (node.kind !== "DelegatedTag") return null;
  const data = node.tag.data as Partial<DynamicComponentData>;
  if (
    data.kind !== "dynamic-component" ||
    !data.expr ||
    node.tag.attrs.length > 0 ||
    node.tag.children.length > 0 ||
    node.tag.attrTagProps.length > 0
  ) {
    return null;
  }
  const ast = data.expr.node as ExpressionNode | undefined;
  return contentMemberName(ast) ?? inputMemberName(ast);
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
      const babel = babelParser as unknown as {
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

/**
 * Finds every read of a module-level name in the template's expressions, and
 * renames the ones that cannot keep their name.
 *
 * A template reads a component member by its bare name, so a module-level name
 * (`static let n`, an import) the template reads has to become a member of the
 * generated class. `resolve` is asked about each read of a name the template
 * does not itself bind and answers the member that read must use, or
 * `undefined` when the name is not a module-level value. When the member is not
 * the name itself (the name is also an input, or a class member Angular treats
 * specially), the read is rewritten in place to the member.
 *
 * What counts as a read: an `Identifier` in a value position. A member name
 * (`a.n`), an object key (`{ n: 1 }`), a type annotation and a name an arrow or
 * function parameter binds are not reads. A name the template binds hides the
 * module's inside that binding's scope: a `<for|n|>` or `<define|n|>`
 * parameter, a tag parameter, a `<const/n=…>` or a tag variable `/n` for the
 * siblings after it. A tag whose parameters cannot be parsed binds nothing
 * (core reports that error).
 *
 * Run before `rewriteInputReads`, while `input.x` is still a member read and
 * not the bare `x` it becomes.
 */
function bindModuleReads(
  body: IrNode[],
  ctx: Ctx,
  resolve: (name: string, at: IdentifierAt) => string | undefined,
): void {
  const patternNames = (node: unknown, into: Set<string>): void => {
    if (!node || typeof node !== "object") return;
    const record = node as BabelNode & {
      properties?: Array<BabelNode & { argument?: BabelNode }>;
    };
    switch (record.type) {
      case "Identifier":
        if (record.name) into.add(record.name);
        return;
      case "ObjectPattern":
        for (const prop of record.properties ?? []) {
          patternNames(
            prop.type === "RestElement" ? prop.argument : prop.value,
            into,
          );
        }
        return;
      case "ArrayPattern":
        for (const el of record.elements ?? []) patternNames(el, into);
        return;
      case "RestElement":
        patternNames(record.argument, into);
        return;
      case "AssignmentPattern":
        patternNames(record.left, into);
        return;
      default:
        return;
    }
  };

  /** The names a tag's parameter list or tag variable (source text) binds. */
  const namesOfSource = (sources: unknown, into: Set<string>): void => {
    const texts = (Array.isArray(sources) ? sources : [sources]).filter(
      (t): t is string => typeof t === "string" && t.trim() !== "",
    );
    if (texts.length === 0) return;
    try {
      const babel = babelParser as unknown as {
        parseExpression(source: string, options?: unknown): unknown;
      };
      const arrow = babel.parseExpression(`(${texts.join(", ")}) => 0`, {
        plugins: ["typescript"],
      }) as { params?: unknown[] };
      for (const param of arrow.params ?? []) patternNames(param, into);
    } catch {
      // Core reports unparsable parameters.
    }
  };

  const visit = (
    value: unknown,
    shadowed: ReadonlySet<string>,
    loc: Position,
  ): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) {
      let changed = false;
      for (const item of value) changed = visit(item, shadowed, loc) || changed;
      return changed;
    }
    const node = value as Record<string, unknown> & { type?: string };

    if (node.type === "Identifier") {
      const name = node.name;
      if (typeof name !== "string" || shadowed.has(name)) return false;
      const member = resolve(name, {
        loc: node.loc as IdentifierAt["loc"],
        file: loc.file,
        fallback: loc,
      });
      if (member === undefined || member === name) return false;
      node.name = member;
      return true;
    }

    let inner = shadowed;
    if (
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression" ||
      node.type === "ObjectMethod"
    ) {
      const bound = new Set(shadowed);
      for (const param of (node.params as unknown[]) ?? []) {
        patternNames(param, bound);
      }
      if (node.type === "FunctionExpression") patternNames(node.id, bound);
      inner = bound;
    }

    let changed = false;
    for (const [key, child] of Object.entries(node)) {
      if (
        key === "loc" ||
        key === "extra" ||
        key === "typeAnnotation" ||
        key === "typeParameters" ||
        key === "typeArguments" ||
        key === "returnType"
      ) {
        continue;
      }
      // A parameter list is a binding position, not a read; its defaults are
      // reads, reached through `right`.
      if (key === "params" && inner !== shadowed) {
        for (const param of child as unknown[]) {
          const pattern = param as { type?: string; right?: unknown };
          if (pattern.type === "AssignmentPattern") {
            changed = visit(pattern.right, inner, loc) || changed;
          }
        }
        continue;
      }
      if (key === "id" && node.type === "FunctionExpression") continue;
      // `a.n` and `{ n: 1 }` name a property; `a[n]` and `{ [n]: 1 }` read.
      if (
        key === "property" &&
        (node.type === "MemberExpression" ||
          node.type === "OptionalMemberExpression") &&
        node.computed !== true
      ) {
        continue;
      }
      if (
        key === "key" &&
        (node.type === "ObjectProperty" || node.type === "ObjectMethod") &&
        node.computed !== true
      ) {
        continue;
      }
      changed = visit(child, inner, loc) || changed;
    }
    // `{ n }` prints as shorthand only while key and value agree.
    if (changed && node.type === "ObjectProperty" && node.shorthand === true) {
      node.shorthand = false;
    }
    return changed;
  };

  /** Walks a list of IR nodes; a `<const/n>` or tag variable binds for the rest. */
  const walkSiblings = (
    nodes: unknown[],
    shadowed: ReadonlySet<string>,
    loc: Position,
  ): void => {
    let scope = shadowed;
    for (const node of nodes) {
      walk(node, scope, loc);
      const after = new Set<string>();
      const record = node as { kind?: unknown; name?: unknown; var?: unknown };
      if (record?.kind === "Const" && typeof record.name === "string") {
        after.add(record.name);
      }
      if (record?.var) namesOfSource(record.var, after);
      if (after.size > 0) scope = new Set([...scope, ...after]);
    }
  };

  const walk = (
    value: unknown,
    shadowed: ReadonlySet<string>,
    loc: Position,
  ): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      walkSiblings(value, shadowed, loc);
      return;
    }
    const record = value as Record<string, unknown> & { kind?: string };
    const here = (record.loc as Position) ?? loc;

    // An `Expr` is the only IR value carrying both `code` and `node`.
    if (typeof record.code === "string" && record.node) {
      if (visit(record.node, shadowed, here)) {
        record.code = ctx.generate(
          record.node as Parameters<Ctx["generate"]>[0],
        );
      }
      return;
    }

    // What this node's own parameters and bindings hide from its children.
    const bound = new Set<string>();
    if (Array.isArray(record.bindings)) {
      for (const name of record.bindings) {
        if (typeof name === "string") bound.add(name);
      }
    }
    if (Array.isArray(record.params)) namesOfSource(record.params, bound);
    const inner = bound.size > 0 ? new Set([...shadowed, ...bound]) : shadowed;

    for (const [key, child] of Object.entries(record)) {
      if (key === "node" || key === "loc" || key === "end") continue;
      // A loop's source is evaluated outside the loop's own parameters.
      const scope = key === "source" ? shadowed : inner;
      walk(child, scope, here);
    }
  };

  walkSiblings(body, new Set(), body[0]?.loc as Position);
}

/**
 * Names a component class gives a meaning of its own: a module name equal to
 * one cannot be a plain member, so it is read through `__mxModule_<name>`.
 */
const CLASS_SPECIAL_MEMBERS: ReadonlySet<string> = new Set([
  "constructor",
  "ngOnChanges",
  "ngOnInit",
  "ngDoCheck",
  "ngAfterContentInit",
  "ngAfterContentChecked",
  "ngAfterViewInit",
  "ngAfterViewChecked",
  "ngOnDestroy",
]);

/** Where an `Identifier` read sits, for an error raised at it. */
interface IdentifierAt {
  loc?: {
    start?: { line: number; column: number };
    end?: { line: number; column: number };
  };
  file?: string;
  /** The enclosing expression's position, when the node has none. */
  fallback: Position;
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
 * Rewrites every ruled projection-render idiom into Angular content
 * projection, and reports the ways projected content cannot be used here.
 *
 * `input.content()` is the body slot (`<ng-content>`); any other name is an
 * attribute tag, which Angular matches by attribute selector
 * (`<ng-content select="[header]">`) — both probed, design note A1.
 *
 * Misuses are errors rather than silently-wrong output, each because Angular's
 * projection is a *placement*, not a value:
 *
 * - **A repeated attribute tag.** Angular matches each selector once, so the
 *   second `<ng-content select="[x]">` renders empty.
 * - **A name read both as a slot and bare** (`${input.x()}` and `${input.x}`).
 *   One read wants a projection, the other an `@Input()`; they cannot both be
 *   true of one name, and whichever lost would render blank.
 * - **A slot called with arguments** (`${input.header(1)}`). Projection takes
 *   no parameters — the arguments would be dropped in silence.
 * - **Any value read of a declared `AttrTag`.** Conditions, pass-throughs and
 *   property reads would observe the unbound `never` marker, not projection.
 */
function projectSlots(body: IrNode[], ctx: Ctx): Set<string> {
  const slotLoc = new Map<string, Position>();
  const bareLoc = new Map<string, Position>();
  const projected = new Set(
    ctx.ownInput?.kind === "declared" ? ctx.ownInput.attrTags.keys() : [],
  );

  /** Every direct `input.x` read nested anywhere in an expression AST. */
  const inputMembers = (
    value: unknown,
    names = new Set<string>(),
  ): Set<string> => {
    if (!value || typeof value !== "object") return names;
    if (Array.isArray(value)) {
      for (const item of value) inputMembers(item, names);
      return names;
    }
    const ast = value as ExpressionNode;
    const name = inputMemberName(ast, true);
    if (name) names.add(name);
    for (const [key, child] of Object.entries(ast)) {
      if (key === "loc" || key === "extra") continue;
      inputMembers(child, names);
    }
    return names;
  };

  // First pass: collect every value read except the four ruled render idioms.
  // Declared AttrTag names are projections, so any such read is an immediate
  // positioned error. Undeclared names keep the older inferred-slot guard: if
  // the same name is later rendered as a slot, mixing the two meanings errors.
  const collectValueReads = (value: unknown, loc?: Position): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collectValueReads(item, loc);
      return;
    }
    const record = value as Record<string, unknown> & {
      kind?: string;
      loc?: Position;
    };
    const here = record.loc ?? loc;
    if (isIrNode(record)) {
      const irNode = record as unknown as IrNode;
      if (slotNameOf(irNode) || dynamicSlotNameOf(irNode)) return;
    }
    if (typeof record.code === "string" && record.node) {
      for (const name of inputMembers(record.node)) {
        if (projected.has(name)) {
          throw new TranslateError(
            `@mxlang/host-angular can't read projected content \`${name}\` as a value; render it with <\${input.${name}.content}/>`,
            here?.line ?? 0,
            here?.column ?? 0,
            here?.file,
          );
        }
        if (here && !bareLoc.has(name)) bareLoc.set(name, here);
      }
      return;
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "node" || key === "loc" || key === "end") continue;
      collectValueReads(child, here);
    }
  };
  collectValueReads(body);

  const visit = (nodes: IrNode[]): void => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index] as IrNode;
      rejectSlotCallWithArgs(node);
      const slot = slotNameOf(node) ?? dynamicSlotNameOf(node);
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
            `\`input.${slot}\` is read both as content (\`input.${slot}()\` at ${node.loc.line}:${node.loc.column + 1}) and as a value (\`input.${slot}\` at ${bare.line}:${bare.column + 1}) on Angular. Content projection is a placement, not a value — use one or the other.`,
            node.loc.line,
            node.loc.column,
            node.loc.file,
          );
        }
        slotLoc.set(slot, node.loc);
        if (slot !== "content") projected.add(slot);
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
      const visitNested = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          if (value.some(isIrNode)) visit(value as IrNode[]);
          else for (const item of value) visitNested(item);
          return;
        }
        for (const [key, child] of Object.entries(value)) {
          if (key === "node" || key === "loc" || key === "end") continue;
          visitNested(child);
        }
      };
      visitNested(node);
    }
  };

  visit(body);
  return projected;
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
 * A tag file has no class the author can write (the component class is
 * generated), so the page text "declare it in the component class" would send
 * the author nowhere. A `const` still becomes a `<const>` (`@let`); a `let` or
 * `var` is pointed at a `.ng.mx` component, which owns its class.
 */
const tagDeclarations: HostDeclarations = {
  ...angularDeclarations,
  scriptletReplacement: (name, keyword) =>
    keyword === "const"
      ? `declare a value with \`<const/${name}=…/>\``
      : "a tag has no class of its own: write the component as `.ng.mx` and declare it in its class",
};

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
  const templateMappings: AngularMapping[] = [];
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
  /**
   * The module-level names the template reads, in first-read order, each with
   * the class member the template reads it through.
   */
  const moduleReads = new Map<string, string>();
  /** What every module-level name is, for the accessors `moduleNameMembers` writes. */
  let moduleBindings = new Map<string, ModuleBindingKind>();

  const result = compileSourceWithHint(source, filename, tagDeclarations, {
    customTags: options.customTags,
    defaultTag: options.defaultTag,
    targets: options.targets ?? angularOwnTargets,
    warnings,
    emitIr: (lowered: Ir, ctx: Ctx) => {
      // `projectSlots` and `rewriteInputReads` replace nodes and edit
      // `Expr.code` and the parser nodes in place, so they run on a private
      // copy: the IR is read-only to an emitter (ir-spec E21).
      const ir = cloneIr(lowered, { nodes: true });
      className = moduleExportName(ir, "@mxlang/host-angular");
      // `<return>` hands a value to the tag's *caller*, through `/var` on
      // every host whose template can bind one. An Angular component is
      // called by its selector, as a plain element — there is no binding
      // position in Angular template syntax to receive a return value, and
      // the core's own `<return>` lowering has no host-agnostic fallback:
      // left unchecked, `<return value=x/>` lowers like any other tag and
      // is emitted as a literal `<return [value]="x">` element in the
      // template (the S8 silent-drop class this whole pass exists to
      // prevent — it does not even render blank, it renders an unknown
      // element `ng build` then fails on with no MX diagnostic pointing at
      // the cause). Reported here, before the body walk, rather than left
      // for `ng build`/`parseTemplate` to discover downstream.
      if (ir.returnValue) {
        const at = ir.returnValue.node?.loc?.start;
        throw returnRefusal(
          ctx,
          filename,
          at,
          "Declare the value as an `@Input()`, or expose it as a `static`/`export` from the tag's module.",
        );
      }
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
        if (node.code === "") continue;
        // `export const selector = "…"` is the tag author's own selector
        // (design note O9, RULED): the tag owns its element name, so the
        // derived default is overridable. Consumed here rather than passed
        // through, since it becomes the `@Component({ selector })` value.
        const declaration = selectorDeclarationOf(node.code);
        if (declaration?.kind === "literal") {
          selector = declaration.value;
          continue;
        }
        if (declaration) {
          // Not statically readable: the same warning the call sites of this
          // tag give, and the statement stays an ordinary export.
          warn(ctx, {
            message: unreadableSelectorMessage(
              `${prefix}${kebabCase(basename)}`,
            ),
            ...node.loc,
          } as MxWarning);
        }
        passthroughExports.push(node.code);
      }

      if (ir.inputInterface) {
        inputProps = parseInputProps(ir.inputInterface);
        if (ir.needsAttrTagImport) {
          moduleLines.push(
            'import type { AttrTag } from "@mxlang/host-angular";',
          );
        }
        moduleLines.push(ir.inputInterface.code);
      }

      // Before `input.x` is rewritten to the bare `x`: only a name the author
      // wrote bare can be a module-level name. A module name that is also an
      // input, or that Angular treats specially on a class, is read through a
      // generated member, so the bare `x` of an input and of the module stay
      // two members.
      moduleBindings = collectModuleBindings([
        ...moduleLines,
        ...passthroughExports,
      ]);
      const inputNames = new Set(inputProps.map((prop) => prop.name));
      bindModuleReads(ir.body, ctx, (name, at) => {
        const kind = moduleBindings.get(name);
        if (kind === undefined || kind === "type") return undefined;
        const start = at.loc?.start ?? at.fallback;
        if (kind === "constEnum") {
          const error = new TranslateError(
            `\`${name}\` is a \`const enum\`, which has no run-time value for a template to read. Drop \`const\` from the enum.`,
            start.line,
            start.column,
            at.file ?? filename,
          );
          const end = at.loc?.end ?? start;
          error.end = { line: end.line, column: end.column };
          throw error;
        }
        const member =
          inputNames.has(name) || CLASS_SPECIAL_MEMBERS.has(name)
            ? `__mxModule_${name}`
            : name;
        moduleReads.set(name, member);
        return member;
      });

      // Order matters: slot reads are `input.content()` / `input.header()`
      // calls, so they must be recognised and replaced *before* `input.` is
      // stripped off every remaining read.
      const projectedSlots = projectSlots(ir.body, ctx);
      inputProps = inputProps.filter((prop) => !projectedSlots.has(prop.name));
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
        templateMappings,
        undefined,
        true,
      );
      return template;
    },
  });

  // The members are written below, so the emitter's "add them yourself"
  // advice does not apply to a tag module.
  for (let i = warnings.length - 1; i >= 0; i--) {
    const code = (warnings[i] as { code?: string }).code;
    if (code !== undefined && HELPER_ADVICE_CODES.includes(code)) {
      warnings.splice(i, 1);
    }
  }

  const directives = directivesFor(template);

  // Every identifier the emitted module does not itself own: the author's
  // module-level statements, their `export interface Input`, and the class
  // name the core derived. Each emitted Angular identifier is checked against
  // this set and aliased when it collides — one pass, rather than a rule per
  // symbol, so a construct that starts emitting a new Angular import cannot
  // forget to be collision-checked.
  const authored = collectAuthoredIdentifiers([
    ...moduleLines,
    ...passthroughExports,
  ]);
  // `export interface Input` is the tag-module contract's own name for the
  // props interface, so it is authored whether or not the author wrote the
  // interface themselves.
  if (
    inputProps.length > 0 ||
    moduleLines.some((l) => /\binterface Input\b/.test(l))
  ) {
    authored.add("Input");
  }

  // The class name is a declaration in the emitted module too, so an emitted
  // import colliding with it is the same `TS2395`. It is the one identifier
  // that can be renamed instead of aliased, since nothing outside the module
  // refers to it by name (the default export carries it).
  if (authored.has(className)) {
    className = uniqueName(className, authored);
  }
  authored.add(className);

  /**
   * Emits `X`, or `X as <alias>` when `X` is a name the author owns.
   *
   * `preferred` names the alias to reach for first, for a symbol whose
   * aliased spelling is already established and documented (`Input as
   * NgInput`); it falls back to the generic `Mx`-prefixed form when even the
   * preferred name is taken.
   */
  const emitted = new Map<string, string>();
  const importSpec = (symbol: string, preferred?: string): string => {
    let local = symbol;
    if (authored.has(symbol)) {
      local =
        preferred && !authored.has(preferred)
          ? preferred
          : uniqueName(symbol, authored);
    }
    authored.add(local);
    emitted.set(symbol, local);
    return local === symbol ? symbol : `${symbol} as ${local}`;
  };
  /** The local name an emitted Angular symbol ended up under. */
  const localOf = (symbol: string): string => emitted.get(symbol) ?? symbol;

  const angularImports = [importSpec("Component")];
  const hasInputs = inputProps.length > 0;
  // `Input` always collides with the contract's own interface name when there
  // are props, which is why it is aliased unconditionally rather than only
  // when `authored` happens to contain it.
  if (hasInputs) angularImports.push(importSpec("Input", "NgInput"));
  // A tag call assigns `class` as a plain property each parent pass. Under the
  // OnPush default that assignment never marks this view dirty, so the callee
  // would keep rendering the first class it saw. Eager checks it on every pass.
  const eagerForClass = inputProps.some((prop) => prop.name === "class");
  if (eagerForClass) angularImports.push(importSpec("ChangeDetectionStrategy"));

  /**
   * The class members that expose the module-level names the template reads.
   *
   * A template resolves a bare name against the component instance, and a
   * module-level `let`, `const`, function or import is not a member of it:
   * `{{ n }}` renders blank, or fails `ng build` under `strictTemplates`.
   * Each name is exposed through an accessor rather than a copy, so a
   * `static let` that the module's own code reassigns is read at its current
   * value; a `let` or `var` also gets a setter, so an assignment in the
   * template reaches the module's variable. Inside the accessor the name is
   * the module's: a class member is not a lexical binding. A name that is also
   * an input is exposed as `__mxModule_<name>`, and the template's reads of it
   * were rewritten to that.
   */
  const moduleNameMembers = (): string[] => {
    const members: string[] = [];
    for (const [name, member] of moduleReads) {
      members.push(`  protected get ${member}() { return ${name}; }`);
      if (moduleBindings.get(name) === "mutable") {
        // The parameter cannot be called `value`: the module may declare it.
        members.push(
          `  protected set ${member}(__mxNext: typeof ${name}) { ${name} = __mxNext; }`,
        );
      }
    }
    return members;
  };

  const lines: string[] = [
    `import { ${angularImports.join(", ")} } from "@angular/core";`,
  ];
  if (directives.length > 0) {
    lines.push(
      `import { ${directives.map((d) => importSpec(d)).join(", ")} } from "@angular/common";`,
    );
  }
  for (const tag of usedTags) {
    const local = authored.has(tag.className)
      ? uniqueName(tag.className, authored)
      : tag.className;
    authored.add(local);
    emitted.set(tag.className, local);
    lines.push(`import ${local} from ${JSON.stringify(tag.specifier)};`);
  }
  if (moduleLines.length > 0) lines.push("", ...moduleLines);
  if (passthroughExports.length > 0) lines.push("", ...passthroughExports);

  const componentImports = [
    ...directives.map(localOf),
    ...usedTags.map((t) => localOf(t.className)),
  ];
  lines.push(
    "",
    `@${localOf("Component")}({`,
    `  selector: ${JSON.stringify(selector)},`,
    "  standalone: true,",
    `  imports: [${componentImports.join(", ")}],`,
    `  template: ${quoteTemplate(template)},`,
    ...(eagerForClass
      ? [`  changeDetection: ${localOf("ChangeDetectionStrategy")}.Eager,`]
      : []),
    "})",
    `export class ${className} {`,
  );
  for (const prop of inputProps) {
    // A non-optional property is `required: true`, so Angular reports a
    // missing attribute at the call site rather than rendering `undefined`.
    const decorator = prop.optional
      ? `@${localOf("Input")}()`
      : `@${localOf("Input")}({ required: true })`;
    // `!` on a required input: it is assigned by Angular, not the constructor,
    // which `strictPropertyInitialization` cannot see.
    const mark = prop.optional ? "?" : "!";
    lines.push(`  ${decorator} ${prop.name}${mark}: ${prop.type};`);
  }
  // The template calls the event invoker on the component instance, so the
  // class must carry it (detected from the emitted text, like directives).
  lines.push(...moduleNameMembers());
  lines.push(...helperMembersFor(template));
  lines.push("}", `export default ${className};`, "");

  const code = lines.join("\n");
  // Located in the assembled module rather than computed from the pieces:
  // the quoted template is a unique, unambiguous string, and finding it is
  // immune to any change in how the lines above are built.
  const quoted = quoteTemplate(template);
  const quotedStart = code.indexOf(quoted);
  // The quoted template was written into `lines` a few statements above, so
  // not finding it means this assembly and `quoteTemplate` have diverged.
  // Returning no mappings would degrade silently into "this tag has no
  // positions", which reads as a template with nothing to map rather than a
  // compiler bug.
  if (quotedStart < 0) {
    throw new Error(
      `@mxlang/host-angular internal: the quoted template is not present in the emitted module for ${filename}`,
    );
  }
  const mappings = templateMappingsToModule(
    template,
    templateMappings,
    quotedStart,
  );

  return {
    ...result,
    code,
    map: {
      ...result.map,
      mappings: encodeMappings(code, source, mappings),
    },
    mappings,
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
