/**
 * Reads a page's hand-written component class to decide whether it already
 * provides the event invoker (`__mxOn` / `__mxOnAt`), so the build does not
 * tell the author to add what the class has.
 *
 * A page `foo.mx` is paired with its sibling `foo.ts` (the same name the
 * build's header already tells the author to edit). The class is read with a
 * light Babel parse, never type-checked, so it sees only what the file says:
 * a base imported from another module cannot be followed, so a class whose
 * chain leaves the file is `unknown` unless it declares both members itself.
 * All `@Component` classes in the file are judged; `templateUrl` is not
 * matched (a second component with the invoker could silence the warning for
 * a template bound to a class elsewhere — rare, noted). Every failure (no file, unreadable, unparsable, no
 * component class) answers `unknown`, and the caller keeps the warning —
 * a redundant hint is cheaper than a silent missing member.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { EVENT_HELPER_NAMES, RUNTIME_SPECIFIER } from "./emitter.ts";

const require = createRequire(import.meta.url);

/** One component class in the file, and which invoker members it lacks. */
export interface PageClassReport {
  name: string;
  /** The invoker members the class neither declares nor inherits (never empty here). */
  missing: string[];
}

export type PageClassInspection =
  | { status: "unknown" }
  /** Every component class in the file provides both members. */
  | { status: "provided" }
  /** At least one component class lacks a member. */
  | { status: "missing"; file: string; classes: PageClassReport[] };

interface Node {
  type: string;
  name?: string;
  value?: string;
  computed?: boolean;
  start?: number;
  [key: string]: unknown;
}

const asNode = (value: unknown): Node | undefined =>
  value && typeof value === "object" && "type" in value
    ? (value as Node)
    : undefined;

/** Whether the class carries a `@Component(...)` decorator. */
function isComponent(klass: Node): boolean {
  const decorators = (klass.decorators as Node[] | undefined) ?? [];
  return decorators.some((d) => {
    const expression = asNode(d.expression);
    const callee =
      expression?.type === "CallExpression"
        ? asNode(expression.callee)
        : expression;
    return callee?.type === "Identifier" && callee.name === "Component";
  });
}

function memberName(member: Node): string | undefined {
  if (member.computed) return undefined;
  const key = asNode(member.key);
  if (key?.type === "Identifier") return key.name;
  if (key?.type === "StringLiteral") return key.value;
  return undefined;
}

export function inspectPageClass(classFile: string): PageClassInspection {
  try {
    const source = readFileSync(classFile, "utf8");
    const babel = require("@marko/compiler/internal/babel") as {
      parse(source: string, options: unknown): unknown;
    };
    const file = babel.parse(source, {
      sourceType: "module",
      plugins: [["typescript", {}], "decorators-legacy"],
    });
    return inspectFile(file, basename(classFile));
  } catch {
    return { status: "unknown" };
  }
}

/** The top-level class declarations of a statement list, through `export`/`export default`. */
function topLevelClass(statement: Node): Node | undefined {
  if (statement.type === "ClassDeclaration") return statement;
  if (
    statement.type === "ExportNamedDeclaration" ||
    statement.type === "ExportDefaultDeclaration"
  ) {
    const declaration = asNode(statement.declaration);
    if (declaration?.type === "ClassDeclaration") return declaration;
  }
  return undefined;
}

/**
 * Whether a class member is a real instance member at run time. `declare`,
 * `static`, `abstract`, a bodiless method, a property with no initializer and
 * a setter-only accessor type-check but leave `ctx.__mxOn` undefined (or not
 * callable) on the instance.
 */
function isInstanceMember(member: Node): boolean {
  if (member.declare || member.static || member.abstract) return false;
  if (member.type === "TSDeclareMethod") return false;
  // A property with no initializer (`x: any`, `x?: any`, `x!: any`) is never
  // assigned, so it is `undefined` on the instance whatever `strict` says.
  if (member.type === "ClassProperty" && !member.value) return false;
  // A setter-only accessor reads back `undefined`; a getter may return a fn.
  if (member.kind === "set") return false;
  return true;
}

function inspectFile(file: unknown, filename: string): PageClassInspection {
  const program = asNode(asNode(file)?.program);
  const statements = (program?.body as Node[] | undefined) ?? [];
  const runtimeLocals = new Set<string>();
  const runtimeNamespaces = new Set<string>();
  const declared = new Map<string, Node>();
  const classes: Node[] = [];
  for (const statement of statements) {
    if (statement.type === "ImportDeclaration") {
      if (asNode(statement.source)?.value !== RUNTIME_SPECIFIER) continue;
      if (statement.importKind === "type") continue;
      for (const spec of (statement.specifiers as Node[] | undefined) ?? []) {
        const local = asNode(spec.local)?.name;
        if (!local || spec.importKind === "type") continue;
        if (spec.type === "ImportNamespaceSpecifier") {
          runtimeNamespaces.add(local);
        } else if (spec.type === "ImportSpecifier") {
          const imported = asNode(spec.imported);
          const name = imported?.name ?? imported?.value;
          if (name === "MxHandlers" || name === "MxHandlersMixin") {
            runtimeLocals.add(local);
          }
        }
      }
      continue;
    }
    const klass = topLevelClass(statement);
    if (klass) {
      classes.push(klass);
      const id = asNode(klass.id)?.name;
      // An ambient `declare class` has no body to read: treat it as unseen.
      if (id && !klass.declare) declared.set(id, klass);
    }
  }

  // Only the shapes resolved through the runtime subpath count:
  // `extends X`, `extends X(...)` (also nested: `extends O(X(...))`) and
  // `extends ns.X` / `ns.X(...)`.
  const isRuntimeRef = (n: Node | undefined): boolean => {
    if (n?.type === "Identifier") return runtimeLocals.has(n.name ?? "");
    const object = asNode(n?.object);
    const property = asNode(n?.property);
    return (
      n?.type === "MemberExpression" &&
      !n.computed &&
      object?.type === "Identifier" &&
      runtimeNamespaces.has(object.name ?? "") &&
      (property?.name === "MxHandlers" || property?.name === "MxHandlersMixin")
    );
  };
  // A wrapper call counts when the runtime is reached through its FIRST
  // argument (`Other(MxHandlersMixin(Base))`); a mixin taking the base in a
  // later position is not followed, so that chain is unseen (`unknown`).
  const reachesRuntime = (base: Node | undefined): boolean => {
    if (base?.type !== "CallExpression") return isRuntimeRef(base);
    if (isRuntimeRef(asNode(base.callee))) return true;
    const [first] = (base.arguments as Node[] | undefined) ?? [];
    return reachesRuntime(asNode(first));
  };
  // The members a class has, and whether its whole chain was seen. A base
  // that is neither the runtime nor a top-level class of this file (imported,
  // a `const B = class ...`, a wrapper call with no runtime inside) may carry
  // the members, so the chain is `complete: false` and nobody may claim
  // anything is missing.
  const membersOf = (
    klass: Node,
    seen = new Set<Node>(),
  ): { names: Set<string>; complete: boolean } => {
    const names = new Set<string>();
    if (seen.has(klass)) return { names, complete: true };
    seen.add(klass);
    const body = asNode(klass.body);
    for (const member of (body?.body as Node[] | undefined) ?? []) {
      if (!isInstanceMember(member)) continue;
      const name = memberName(member);
      if (name) names.add(name);
    }
    const superClass = asNode(klass.superClass);
    if (!superClass) return { names, complete: true };
    if (reachesRuntime(superClass)) {
      for (const n of EVENT_HELPER_NAMES) names.add(n);
      return { names, complete: true };
    }
    const base =
      superClass.type === "Identifier" && superClass.name
        ? declared.get(superClass.name)
        : undefined;
    if (!base) return { names, complete: false };
    const inherited = membersOf(base, seen);
    for (const n of inherited.names) names.add(n);
    return { names, complete: inherited.complete };
  };

  const components = classes.filter(isComponent);
  if (components.length === 0) return { status: "unknown" };
  const reports: PageClassReport[] = [];
  for (const klass of components) {
    const { names, complete } = membersOf(klass);
    const missing = EVENT_HELPER_NAMES.filter((n) => !names.has(n));
    if (missing.length === 0) continue;
    // Cannot see the whole chain: keep the original warning, claim nothing.
    if (!complete) return { status: "unknown" };
    reports.push({ name: asNode(klass.id)?.name ?? "(anonymous)", missing });
  }
  return reports.length === 0
    ? { status: "provided" }
    : { status: "missing", file: filename, classes: reports };
}
