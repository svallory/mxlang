/**
 * Module level code cannot name what exists only while the template renders.
 *
 * `static`, `server`, `client` and `export` statements run once, as
 * the template's module loads. A tag variable (`<let/x>`, `<const/x>`,
 * `<define/Foo>`, any `/var`), `input`, `$global` and `$signal` come into
 * being per render, so module code that names one has nothing to read.
 * Marko 6 refuses the file; core refuses it the same way, before any target
 * sees it, positioned at the name.
 *
 * What counts as a name:
 *
 * - A reference to a tag variable declared anywhere in the file (before or
 *   after the module statement, in the template's top level or nested in a tag
 *   body), or to `input`, `$global` or `$signal`. A tag param (`<for|item|>`)
 *   is not one: it is only in scope inside its own tag, so module code that
 *   spells `item` reads a global, which is what Marko compiles it as.
 * - A module level declaration of the spelling of a tag variable declared in
 *   the template's top level (`static count = 1` beside `<let/count=0/>`):
 *   the two would be one name. A tag variable nested in a tag body is a
 *   different scope, and a module binding of its spelling shadows it.
 *
 * What does not: a parameter or local of a module function (`static function
 * f(input) { return input }`), a module binding that shares the spelling of a
 * name only a nested tag declares, a property name (`o.input`, `{ input: 1 }`),
 * and anything inside a type (`typeof count`) or an ambient declaration
 * (`static declare const count: number`, `import type { count }`).
 *
 * A module level declaration spelled `input` is refused too, in every form
 * (`static const input`, `static function input`, `export const input`, a
 * destructured name, a `static input = 1`, an ambient `declare const input`),
 * as Marko refuses it. `$global` and `$signal` can be declared: Marko accepts
 * that, and a reference to them stays refused unless the module declares them.
 *
 * An `import` is checked for its declarations only: it spells no reference.
 * An import of `input` does not exempt module code's `input`, which stays the
 * render's own.
 *
 * `static { … }` is module code with the braces removed: its top-level
 * declarations are module bindings, and a declaration nested in an inner block
 * or a function is not.
 *
 * The check runs when the lowerer reaches the statement, so a host that
 * refuses `server` or `client` outright reports that first. It is skipped
 * under the `none` tag rules, where a dialect owns what its tags and its
 * statements mean.
 *
 * The same scan checks the module's own bindings, for every host and every
 * target (`MX_DUPLICATE_DECLARATION`, `MX_UNDECLARED_EXPORT`). The module
 * statements share one scope, as the file's single module does once they are
 * hoisted: a name is declared once across `import`, `static`, `server`,
 * `client` and `export`, in block and block-less form. The rule is
 * JavaScript's, applied after the TypeScript strip. Two `var`s of a name
 * merge, and so do the declarations TypeScript merges: enum with enum (and
 * namespace), a namespace after a function, class, enum or namespace, and
 * function overloads. Type-only names (`type`, `interface`, `import type`)
 * are not values and never collide. The second declaration is refused,
 * positioned at its name. An `export { q }` whose `q` no module statement
 * declares (before or after it; a type counts, an ambient `declare` value does
 * not) is refused at `q`, because the module it makes cannot load. A re-export
 * (`export { q } from "m"`) and a type export (`export type { T }`) bind
 * nothing local.
 */

import { coreBabel } from "./babel.ts";
import {
  bindingIdentifiers,
  bodyChildren,
  type Ctx,
  isStatementNode,
  isTagOrStatementNode,
  type Node,
  positionAtOffset,
  raise,
  sliceNode,
} from "./core.ts";
import {
  DUPLICATE_DECLARATION_CODE,
  RENDER_ONLY_IN_MODULE_CODE,
  UNDECLARED_EXPORT_CODE,
} from "./diagnostic-codes.ts";
import { parseAuthoredSource } from "./reserved-bindings.ts";
import { blankStatementBlock } from "./statement-block.ts";
import { hasStaticName, tagNameOf, tagVarOf } from "./tag-fields.ts";

/** The names that exist per render without any tag declaring them. */
const IMPLICIT = ["input", "$global", "$signal"] as const;

const MODULE_STATEMENTS = new Set([
  "import",
  "static",
  "export",
  "server",
  "client",
]);

/** One parsed module statement: its tree and the names it binds at module level. */
interface Parsed {
  readonly file: Node;
  /** `static { … }`: its statements are the module's, the braces are gone. */
  readonly block: boolean;
  readonly bindings: ReadonlySet<string>;
  /** Every declaration of the statement, for the duplicate and export checks. */
  readonly declared: StatementDeclarations;
}

/** What a template's module statements are checked against. */
export interface ModuleScope {
  /** Every tag variable name in the file, nested or not. */
  readonly renderOnly: ReadonlySet<string>;
  /** The tag variable names declared in the template's top level. */
  readonly topLevel: ReadonlySet<string>;
  /** Every module statement in the file, in source order. */
  readonly statements: readonly Node[];
  /** Parse results by statement; `null` when the text did not parse. */
  readonly parsed: Map<Node, Parsed | null>;
  /** The names every module statement binds, filled on first use. */
  moduleBindings?: ReadonlySet<string>;
  /** The binding errors by the statement that holds them, filled on first use. */
  bindingErrors?: Map<Node, BindingError>;
}

/**
 * Reads the tag variables and the module statements of a template body.
 * `undefined` when there is no module statement to check, and under the
 * `none` tag rules.
 */
export function scanModuleScope(
  ctx: Ctx,
  body: readonly Node[],
): ModuleScope | undefined {
  if (ctx.tagRules === "none") return undefined;
  const renderOnly = new Set<string>();
  const topLevel = new Set<string>();
  const statements: Node[] = [];
  const visit = (nodes: readonly Node[], top: boolean): void => {
    for (const node of nodes) {
      if (!isTagOrStatementNode(node)) continue;
      if (hasStaticName(node)) {
        const name = tagNameOf(node) as string;
        if (isStatementNode(node) && MODULE_STATEMENTS.has(name)) {
          statements.push(node);
        } else if (tagVarOf(node) && !isRefused(ctx, name)) {
          for (const bound of bindingIdentifiers(tagVarOf(node))) {
            renderOnly.add(bound);
            if (top) topLevel.add(bound);
          }
        }
      }
      visit(bodyChildren(node), false);
      visit(node.attributeTags ?? [], false);
    }
  };
  visit(body, true);
  if (statements.length === 0) return undefined;
  return { renderOnly, topLevel, statements, parsed: new Map() };
}

/** Does the host refuse this tag outright? Then its variable never exists. */
function isRefused(ctx: Ctx, name: string): boolean {
  const disposition = Object.hasOwn(ctx.declarations.tags, name)
    ? ctx.declarations.tags[name]
    : undefined;
  return disposition?.kind === "error" || disposition?.kind === "unsupported";
}

/** Parses one module statement, keeping every character at its file position. */
function parseStatement(
  ctx: Ctx,
  scope: ModuleScope,
  node: Node,
): Parsed | null {
  const known = scope.parsed.get(node);
  if (known !== undefined) return known;
  let result: Parsed | null = null;
  try {
    let source = sliceNode(ctx, node);
    const keyword = /^(static|server|client)\b/.exec(source)?.[0];
    let block = false;
    if (keyword) {
      source = " ".repeat(keyword.length) + source.slice(keyword.length);
      // `static { … }`: the braces are blanked, so the block's statements are
      // the module's own and the positions do not move. Only a body that is
      // exactly one block unwraps, as lowering reads it.
      const unwrapped = blankStatementBlock(source);
      if (unwrapped !== source) {
        source = unwrapped;
        block = true;
      }
    }
    const at = node.loc?.start ?? positionAtOffset(ctx, node.start);
    const file = parseAuthoredSource(source, at.line, at.column, {
      errorRecovery: true,
    });
    result = {
      file,
      block,
      bindings: moduleLevelNames(file, block),
      declared: statementDeclarations(file),
    };
  } catch {
    // A statement that does not parse is the statement checks' to report.
  }
  scope.parsed.set(node, result);
  return result;
}

/**
 * `static count = 1`: a statement that is one assignment to a name. Outside
 * a `static { … }` block it declares the name, as Marko reads it.
 */
function declaringAssignment(path: Node, block: boolean): boolean {
  const { node, parentPath } = path;
  return (
    !block &&
    node.operator === "=" &&
    node.left.type === "Identifier" &&
    parentPath.isExpressionStatement() &&
    parentPath.parentPath.isProgram()
  );
}

/** The names a parsed statement declares at module level. */
function moduleLevelNames(file: Node, block: boolean): ReadonlySet<string> {
  const names = new Set<string>();
  coreBabel().traverse(file, {
    Program(path: Node) {
      for (const [name, binding] of Object.entries<Node>(path.scope.bindings)) {
        if (ambient(binding.path)) continue;
        // `input` is the render's own; an import of that spelling does not
        // make module code's `input` something else. A declaration of it is
        // refused (`declaresInput`), so its references need no second error.
        if (name === "input" && imported(binding)) continue;
        names.add(name);
      }
    },
    AssignmentExpression(path: Node) {
      if (declaringAssignment(path, block)) names.add(path.node.left.name);
    },
  });
  return names;
}

/** The names any module statement of the file declares. */
function moduleBindings(ctx: Ctx, scope: ModuleScope): ReadonlySet<string> {
  if (scope.moduleBindings) return scope.moduleBindings;
  const all = new Set<string>();
  for (const statement of scope.statements) {
    for (const name of parseStatement(ctx, scope, statement)?.bindings ?? []) {
      all.add(name);
    }
  }
  scope.moduleBindings = all;
  return all;
}

/**
 * Is `path` an ambient declaration (`declare const x: number`, `declare
 * function f(): void`) or a type-only import? It declares a type-level name,
 * not a value that exists at load.
 */
function ambient(path: Node): boolean {
  return Boolean(
    path.find(
      (p: Node) =>
        p.node.declare === true ||
        p.node.importKind === "type" ||
        p.node.importKind === "typeof" ||
        p.isTSDeclareFunction(),
    ),
  );
}

/** Is `path` inside a type or an ambient declaration? Neither names a value. */
function insideType(path: Node): boolean {
  return (
    ambient(path) ||
    Boolean(
      path.findParent(
        (parent: Node) =>
          parent.isTSType() ||
          parent.isTSTypeAnnotation() ||
          parent.isTSTypeParameterInstantiation() ||
          parent.isTSTypeParameterDeclaration() ||
          parent.isTSInterfaceDeclaration() ||
          parent.isTSTypeAliasDeclaration(),
      ),
    )
  );
}

/**
 * Does this module level binding declare `input` (an import does not: it is
 * only a binding, and a reference to `input` is refused whatever imports it)?
 */
function declaresInput(name: string, binding: Node): boolean {
  return name === "input" && !imported(binding);
}

/** Is this binding made by an import specifier, type-only or not? */
function imported(binding: Node): boolean {
  return (
    binding.kind === "module" ||
    binding.path.isImportSpecifier() ||
    binding.path.isImportDefaultSpecifier() ||
    binding.path.isImportNamespaceSpecifier()
  );
}

/** A name found in module code, and what it is. */
interface Found {
  readonly node: Node;
  readonly name: string;
  readonly declares: boolean;
}

const WHERE =
  "(`static`, `server`, `client` and `export` statements), which runs once as the template loads";

/**
 * Refuses a module statement that names something which exists only while the
 * template renders, declares a module name a statement before it declared, or
 * exports a name no module statement declares. A no-op for a statement with
 * none of these.
 */
export function checkModuleScope(ctx: Ctx, node: Node): void {
  const scope = ctx.moduleScope;
  if (!scope) return;
  checkRenderOnly(ctx, scope, node);
  const error = bindingErrors(ctx, scope).get(node);
  if (error) raise(error.code, error.message, error.at);
}

/** The render-only half of {@link checkModuleScope}. */
function checkRenderOnly(ctx: Ctx, scope: ModuleScope, node: Node): void {
  const text = sliceNode(ctx, node);
  const candidate = (name: string): boolean =>
    scope.renderOnly.has(name) ||
    (IMPLICIT as readonly string[]).includes(name);
  // Most statements mention none of the names; the parse is only paid for one
  // that does.
  if (![...scope.renderOnly, ...IMPLICIT].some((name) => text.includes(name))) {
    return;
  }
  const parsed = parseStatement(ctx, scope, node);
  if (!parsed) return;

  const found: Found[] = [];
  const { types } = coreBabel();
  /** Records `id` when it names something module code cannot have. */
  const reference = (path: Node, id: Node): void => {
    const { name } = id;
    if (!candidate(name) || insideType(path)) return;
    if (path.scope.getBinding(name)) return;
    if (moduleBindings(ctx, scope).has(name)) return;
    found.push({ node: id, name, declares: false });
  };
  coreBabel().traverse(parsed.file, {
    Program(path: Node) {
      for (const [name, binding] of Object.entries<Node>(path.scope.bindings)) {
        // A declaration spelled `input` is refused even when ambient: `input`
        // is a binding of the render, not only a tag variable's name.
        if (!declaresInput(name, binding) && !scope.topLevel.has(name))
          continue;
        if (name !== "input" && ambient(binding.path)) continue;
        found.push({ node: binding.path.node, name, declares: true });
      }
    },
    AssignmentExpression(path: Node) {
      // A write names its target without making it a reference to Babel.
      if (declaringAssignment(path, parsed.block)) {
        const { name } = path.node.left;
        if (scope.topLevel.has(name) || name === "input") {
          found.push({ node: path.node, name, declares: true });
        }
        return;
      }
      for (const id of Object.values<Node>(
        types.getBindingIdentifiers(path.node.left),
      )) {
        reference(path, id);
      }
    },
    ReferencedIdentifier(path: Node) {
      reference(path, path.node);
    },
  });
  if (found.length === 0) return;
  found.sort((a, b) => a.node.start - b.node.start);
  const first = found[0] as Found;
  raise(
    RENDER_ONLY_IN_MODULE_CODE,
    first.declares
      ? `\`${first.name}\` ${
          first.name === "input"
            ? "is the template's input"
            : "is a tag variable"
        }, which exists only while the template renders, so module level code ${WHERE}, cannot declare a name with its spelling. Rename the module level binding.`
      : `\`${first.name}\` exists only while the template renders, so module level code ${WHERE}, cannot reference it. Reference it in the template instead, passing it to module level functions as an argument.`,
    first.node,
  );
}

/** One module name a statement declares. */
interface Declaration {
  readonly name: string;
  readonly kind: DeclarationKind;
  /** The name's identifier: where an error about it goes. */
  readonly id: Node;
  /** `declare`d, or inside `declare`: it has no runtime. */
  readonly ambient: boolean;
  /** A function with no body: an overload signature or a `declare function`. */
  readonly signature: boolean;
  /** `const enum`: it merges with another `const enum` only. */
  readonly constEnum: boolean;
}

type DeclarationKind =
  | "var"
  | "lexical"
  | "function"
  | "class"
  | "import"
  | "enum"
  | "namespace";

/** What a parsed statement declares and exports at module level. */
interface StatementDeclarations {
  /** The value names, in source order. Types and uninstantiated namespaces are not here. */
  readonly values: readonly Declaration[];
  /** Every name an export list can name: types, and values that survive the strip (not ambient ones). */
  readonly names: ReadonlySet<string>;
  /** The local names of the statement's export lists (`export { q }`). */
  readonly exports: readonly Node[];
  /** Value names only a `declare` or a bodiless signature introduces, by the first such name node. */
  readonly erased: ReadonlyMap<
    string,
    { readonly id: Node; readonly signature: boolean }
  >;
}

/** An error about one module statement. */
interface BindingError {
  readonly code:
    | typeof DUPLICATE_DECLARATION_CODE
    | typeof UNDECLARED_EXPORT_CODE;
  readonly message: string;
  readonly at: Node;
}

/** Does a namespace declare no value (only types, or empty namespaces)? TypeScript emits nothing for it. */
function typeOnlyNamespace(declaration: Node): boolean {
  const body = declaration.body;
  if (!body) return true;
  if (body.type === "TSModuleDeclaration") return typeOnlyNamespace(body);
  return (body.body as Node[]).every(typeOnlyStatement);
}

function typeOnlyStatement(statement: Node): boolean {
  switch (statement.type) {
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
      return true;
    case "TSModuleDeclaration":
      return typeOnlyNamespace(statement);
    case "ExportNamedDeclaration":
      return statement.declaration
        ? typeOnlyStatement(statement.declaration)
        : statement.exportKind === "type";
    default:
      return false;
  }
}

/** The declarations and export lists of one parsed statement. */
function statementDeclarations(file: Node): StatementDeclarations {
  const { types } = coreBabel();
  const values: Declaration[] = [];
  const names = new Set<string>();
  const exports: Node[] = [];
  const erased = new Map<string, { id: Node; signature: boolean }>();
  const add = (
    kind: DeclarationKind,
    id: Node,
    extra: Partial<Declaration> = {},
  ): void => {
    // An ambient value (`declare const d`) is erased with the TypeScript
    // strip, so an export list naming only it names nothing at run time.
    // A signature is not a declaration either: without an implementation the
    // name binds nothing at run time.
    if (extra.ambient !== true && extra.signature !== true) {
      names.add(id.name);
    } else if (!erased.has(id.name)) {
      erased.set(id.name, {
        id,
        signature: extra.ambient !== true,
      });
    }
    values.push({
      name: id.name,
      kind,
      id,
      ambient: false,
      signature: false,
      constEnum: false,
      ...extra,
    });
  };
  const walk = (statement: Node): void => {
    switch (statement.type) {
      case "ImportDeclaration": {
        const typeOnly =
          statement.importKind === "type" || statement.importKind === "typeof";
        for (const specifier of statement.specifiers as Node[]) {
          const kind = specifier.importKind;
          if (typeOnly || kind === "type" || kind === "typeof") {
            names.add(specifier.local.name);
          } else {
            add("import", specifier.local);
          }
        }
        return;
      }
      case "TSImportEqualsDeclaration":
        if (statement.importKind === "type") names.add(statement.id.name);
        else add("import", statement.id);
        return;
      case "VariableDeclaration":
        // A `var` is read from the scope below: one nested in a block hoists.
        if (statement.kind === "var") return;
        for (const declarator of statement.declarations as Node[]) {
          for (const id of Object.values<Node>(
            types.getBindingIdentifiers(declarator.id),
          )) {
            add("lexical", id, { ambient: statement.declare === true });
          }
        }
        return;
      case "FunctionDeclaration":
        add("function", statement.id);
        return;
      case "TSDeclareFunction":
        add("function", statement.id, {
          signature: true,
          ambient: statement.declare === true,
        });
        return;
      case "ClassDeclaration":
        add("class", statement.id, { ambient: statement.declare === true });
        return;
      case "TSEnumDeclaration":
        add("enum", statement.id, {
          ambient: statement.declare === true,
          constEnum: statement.const === true,
        });
        return;
      case "TSModuleDeclaration": {
        // `declare module "m"` and `declare global` name no binding.
        const id = statement.id;
        if (id?.type !== "Identifier" || statement.global) return;
        if (typeOnlyNamespace(statement)) names.add(id.name);
        else add("namespace", id, { ambient: statement.declare === true });
        return;
      }
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
        names.add(statement.id.name);
        return;
      case "ExportNamedDeclaration":
        if (statement.declaration) {
          walk(statement.declaration);
          return;
        }
        // A re-export binds nothing locally; a type export is erased.
        if (statement.source || statement.exportKind === "type") return;
        for (const specifier of statement.specifiers as Node[]) {
          if (
            specifier.type === "ExportSpecifier" &&
            specifier.exportKind !== "type" &&
            specifier.local?.type === "Identifier"
          ) {
            exports.push(specifier.local);
          }
        }
        return;
      case "ExportDefaultDeclaration": {
        const declaration = statement.declaration;
        if (
          declaration?.id &&
          (declaration.type === "FunctionDeclaration" ||
            declaration.type === "TSDeclareFunction" ||
            declaration.type === "ClassDeclaration")
        ) {
          walk(declaration);
        }
        return;
      }
    }
  };
  for (const statement of file.program.body as Node[]) walk(statement);
  coreBabel().traverse(file, {
    Program(path: Node) {
      for (const binding of Object.values<Node>(path.scope.bindings)) {
        if (binding.kind !== "var") continue;
        const declaration = binding.path.parentPath;
        add("var", binding.identifier, {
          ambient: declaration?.node.declare === true,
        });
      }
    },
  });
  values.sort((a, b) => a.id.start - b.id.start);
  return { values, names, exports, erased };
}

/**
 * May `next` be declared after `earlier`, which already declare its name?
 * Only two `var`s, and what TypeScript merges: enum with enum or namespace
 * (a `const enum` only with another), a namespace after a function, class,
 * enum or namespace, a function or class after a namespace (TS2434 applies
 * only when both are non-ambient: a `declare`d side lifts it), and the
 * signatures of an overloaded function followed by one more, all `declare`d
 * or none.
 */
function merges(earlier: readonly Declaration[], next: Declaration): boolean {
  const afterNamespace = (d: Declaration): boolean =>
    d.kind === "namespace" && (d.ambient || next.ambient);
  switch (next.kind) {
    case "var":
      return earlier.every((d) => d.kind === "var");
    case "enum":
      return earlier.every(
        (d) =>
          d.kind === "namespace" ||
          (d.kind === "enum" && d.constEnum === next.constEnum),
      );
    case "namespace":
      return earlier.every((d) =>
        ["function", "class", "enum", "namespace"].includes(d.kind),
      );
    case "function": {
      // A namespace between a signature and what follows it parts them
      // (TS2391), so a namespace may only come before the first function.
      let seenFunction = false;
      return earlier.every((d) => {
        if (d.kind === "function") {
          seenFunction = true;
          return d.signature && d.ambient === next.ambient;
        }
        return !seenFunction && afterNamespace(d);
      });
    }
    case "class":
      return earlier.every(afterNamespace);
    default:
      return false;
  }
}

/** 1-based `line:column`, as an editor shows a position. */
function whereIs(node: Node): string {
  const at = node.loc?.start;
  return at ? `${at.line}:${at.column + 1}` : "earlier in the file";
}

/**
 * The binding errors of the file's module statements, by the statement that
 * holds each one, at most one per statement (its first, by position). Read
 * once for the file, on the first statement checked.
 */
function bindingErrors(
  ctx: Ctx,
  scope: ModuleScope,
): ReadonlyMap<Node, BindingError> {
  if (scope.bindingErrors) return scope.bindingErrors;
  const errors = new Map<Node, BindingError>();
  scope.bindingErrors = errors;
  const record = (statement: Node, error: BindingError): void => {
    const known = errors.get(statement);
    if (!known || error.at.start < known.at.start) {
      errors.set(statement, error);
    }
  };
  const declared = new Map<string, Declaration[]>();
  const parsed = scope.statements.map((statement) => ({
    statement,
    parsed: parseStatement(ctx, scope, statement),
  }));
  for (const { statement, parsed: p } of parsed) {
    if (!p) continue;
    for (const next of p.declared.values) {
      const earlier = declared.get(next.name);
      if (!earlier) {
        declared.set(next.name, [next]);
      } else if (merges(earlier, next)) {
        earlier.push(next);
      } else {
        record(statement, {
          code: DUPLICATE_DECLARATION_CODE,
          message: `Duplicate declaration "${next.name}": it is already declared at ${whereIs((earlier[0] as Declaration).id)}. The \`import\`, \`static\`, \`server\`, \`client\` and \`export\` statements share one module scope, so a name is declared once. Rename one of them, or merge them (two \`var\`s, TypeScript's overloads, enums and namespaces merge).`,
          at: next.id,
        });
      }
    }
  }
  // An export list can name any declaration in the file, above or below it. A
  // statement that did not parse might declare it: the lowering reports that
  // statement, and no name is called undeclared until every one is read.
  if (parsed.every((entry) => entry.parsed)) {
    const all = new Set<string>();
    for (const { parsed: p } of parsed) {
      for (const name of p?.declared.names ?? []) all.add(name);
    }
    const erased = new Map<string, { id: Node; signature: boolean }>();
    for (const { parsed: p } of parsed) {
      for (const [name, entry] of p?.declared.erased ?? []) {
        if (!erased.has(name)) erased.set(name, entry);
      }
    }
    for (const { statement, parsed: p } of parsed) {
      for (const id of p?.declared.exports ?? []) {
        if (all.has(id.name)) continue;
        const hidden = erased.get(id.name);
        const why = hidden
          ? hidden.signature
            ? ` The name is only declared by the function signature at ${whereIs(hidden.id)}, which has no body, so nothing binds it at run time.`
            : ` The name is only declared with \`declare\` at ${whereIs(hidden.id)}, which the TypeScript strip erases, so nothing binds it at run time.`
          : "";
        record(statement, {
          code: UNDECLARED_EXPORT_CODE,
          message: `Export '${id.name}' is not defined in module: no \`import\`, \`static\`, \`server\`, \`client\` or \`export\` statement declares it, so the module cannot load.${why} Declare \`${id.name}\` in a module statement, or remove it from the export list.`,
          at: id,
        });
      }
    }
  }
  return errors;
}
