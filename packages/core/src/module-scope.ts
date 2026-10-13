/**
 * Module level code cannot name what exists only while the template renders.
 *
 * `static`, `server` and `client` blocks and `export` statements run once, as
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
 * and anything inside a type (`typeof count`).
 *
 * `static { … }` is module code with the braces removed: its top-level
 * declarations are module bindings, and a declaration nested in an inner block
 * or a function is not.
 *
 * The check runs when the lowerer reaches the statement, so a host that
 * refuses `server` or `client` outright reports that first. It is skipped
 * under the `none` tag rules, where a dialect owns what its tags and its
 * statements mean.
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
import { RENDER_ONLY_IN_MODULE_CODE } from "./diagnostic-codes.ts";
import { parseAuthoredSource } from "./reserved-bindings.ts";
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
      // the module's own and the positions do not move.
      const braces = /^(\s*)\{([\s\S]*)\}(\s*)$/.exec(source);
      if (braces) {
        source = `${braces[1]} ${braces[2]} ${braces[3]}`;
        block = true;
      }
    }
    const at = node.loc?.start ?? positionAtOffset(ctx, node.start);
    const file = parseAuthoredSource(source, at.line, at.column, {
      errorRecovery: true,
    });
    result = { file, block, bindings: moduleLevelNames(file, block) };
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
      for (const name of Object.keys(path.scope.bindings)) names.add(name);
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

/** Is `path` inside a type? A type names no value. */
function insideType(path: Node): boolean {
  return Boolean(
    path.findParent(
      (parent: Node) =>
        parent.isTSType() ||
        parent.isTSTypeAnnotation() ||
        parent.isTSTypeParameterInstantiation() ||
        parent.isTSTypeParameterDeclaration() ||
        parent.isTSInterfaceDeclaration() ||
        parent.isTSTypeAliasDeclaration(),
    ),
  );
}

/** A name found in module code, and what it is. */
interface Found {
  readonly node: Node;
  readonly name: string;
  readonly declares: boolean;
}

const WHERE =
  "(`static`, `server` and `client` blocks and `export` statements), which runs once as the template loads";

/**
 * Refuses a module statement that names something which exists only while the
 * template renders. A no-op for a file with no such name in the statement.
 */
export function checkModuleScope(ctx: Ctx, node: Node): void {
  const scope = ctx.moduleScope;
  if (!scope) return;
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
        if (!scope.topLevel.has(name)) continue;
        found.push({ node: binding.path.node, name, declares: true });
      }
    },
    AssignmentExpression(path: Node) {
      // A write names its target without making it a reference to Babel.
      if (declaringAssignment(path, parsed.block)) {
        const { name } = path.node.left;
        if (scope.topLevel.has(name)) {
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
      ? `\`${first.name}\` is a tag variable, which exists only while the template renders, so module level code ${WHERE}, cannot declare a name with its spelling. Rename the module level binding.`
      : `\`${first.name}\` exists only while the template renders, so module level code ${WHERE}, cannot reference it. Reference it in the template instead, passing it to a module level function as an argument.`,
    first.node,
  );
}
