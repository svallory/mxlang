/**
 * Reads a page's hand-written component class to decide whether it already
 * provides the event invoker (`__mxOn` / `__mxOnAt`), so the build does not
 * tell the author to add what the class has.
 *
 * A page `foo.mx` is paired with its sibling `foo.ts` (the same name the
 * build's header already tells the author to edit). The class is read with a
 * light Babel parse, never type-checked, so it sees only what the file says:
 * a base imported from another module cannot be followed and counts as
 * providing nothing. Every failure (no file, unreadable, unparsable, no
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

function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  const n = asNode(node);
  if (!n) return;
  visit(n);
  for (const [key, value] of Object.entries(n)) {
    if (key === "loc" || key === "extra") continue;
    if (value && typeof value === "object") walk(value, visit);
  }
}

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

function inspectFile(file: unknown, filename: string): PageClassInspection {
  const runtimeLocals = new Set<string>();
  const runtimeNamespaces = new Set<string>();
  const declared = new Map<string, Node>();
  const classes: Node[] = [];
  walk(file, (node) => {
    if (node.type === "ImportDeclaration") {
      if (asNode(node.source)?.value !== RUNTIME_SPECIFIER) return;
      for (const spec of (node.specifiers as Node[] | undefined) ?? []) {
        const local = asNode(spec.local)?.name;
        if (!local) continue;
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
    } else if (
      node.type === "ClassDeclaration" ||
      node.type === "ClassExpression"
    ) {
      classes.push(node);
      const id = asNode(node.id)?.name;
      if (id && node.type === "ClassDeclaration") declared.set(id, node);
    }
  });

  // Only the three shapes resolved through the runtime subpath count:
  // `extends X`, `extends X(...)` and `extends ns.X` / `ns.X(...)`.
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
  const extendsRuntime = (klass: Node): boolean => {
    const base = asNode(klass.superClass);
    return base?.type === "CallExpression"
      ? isRuntimeRef(asNode(base.callee))
      : isRuntimeRef(base);
  };
  const membersOf = (klass: Node, seen = new Set<Node>()): Set<string> => {
    const names = new Set<string>();
    if (seen.has(klass)) return names;
    seen.add(klass);
    if (extendsRuntime(klass)) for (const n of EVENT_HELPER_NAMES) names.add(n);
    const body = asNode(klass.body);
    for (const member of (body?.body as Node[] | undefined) ?? []) {
      const name = memberName(member);
      if (name) names.add(name);
    }
    const superName = asNode(klass.superClass);
    const base =
      superName?.type === "Identifier" && superName.name
        ? declared.get(superName.name)
        : undefined;
    if (base) for (const n of membersOf(base, seen)) names.add(n);
    return names;
  };

  const components = classes.filter(isComponent);
  if (components.length === 0) return { status: "unknown" };
  const reports: PageClassReport[] = [];
  for (const klass of components) {
    const have = membersOf(klass);
    const missing = EVENT_HELPER_NAMES.filter((n) => !have.has(n));
    if (missing.length > 0) {
      reports.push({ name: asNode(klass.id)?.name ?? "(anonymous)", missing });
    }
  }
  return reports.length === 0
    ? { status: "provided" }
    : { status: "missing", file: filename, classes: reports };
}
