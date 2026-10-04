import { parse } from "@babel/parser";
import { type Ctx, type Node, sliceLoc, TranslateError } from "./core.ts";

/** Shared diagnostic for authored bindings, including host-only code regions. */
export function reservedBindingMessage(name: string): string {
  return `Identifiers starting with "__mx" are reserved for generated code; rename "${name}".`;
}

/**
 * Checks parsed authored code, not references, property keys or generated IR.
 * Marko binding patterns and ordinary Babel declarations share this walk.
 * Host module callers must exclude their lowered/generated region subtrees.
 */
export function checkReservedBindings(tree: unknown): void {
  const seen = new Set<object>();
  const check = (pattern: Node): void => {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier":
      case "TSTypeParameter": {
        const name = pattern.name;
        if (typeof name === "string" && name.startsWith("__mx")) {
          const at = pattern.loc?.start;
          throw new TranslateError(
            reservedBindingMessage(name),
            at?.line ?? 1,
            at?.column ?? 0,
          );
        }
        break;
      }
      case "ObjectPattern":
        for (const p of pattern.properties) check(p.value ?? p.argument);
        break;
      case "ArrayPattern":
        for (const p of pattern.elements) check(p);
        break;
      case "AssignmentPattern":
        check(pattern.left);
        break;
      case "RestElement":
        check(pattern.argument);
        break;
      case "TSParameterProperty":
        check(pattern.parameter);
        break;
    }
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Node;
    // The parser stamps lowered MX regions. Core already checks their authored
    // bindings; walking the generated replacement would reject our own helpers.
    if (node.extra?.mx) return;
    if (node.type === "MarkoTag") check(node.var);
    if (Array.isArray(node.params)) for (const p of node.params) check(p);
    if (
      node.type === "VariableDeclarator" ||
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ClassDeclaration" ||
      node.type === "ClassExpression" ||
      node.type === "TSTypeAliasDeclaration" ||
      node.type === "TSInterfaceDeclaration" ||
      node.type === "TSEnumDeclaration" ||
      node.type === "TSModuleDeclaration" ||
      node.type === "TSImportEqualsDeclaration" ||
      node.type === "TSDeclareFunction"
    )
      check(node.id);
    if (node.type === "CatchClause") check(node.param);
    if (
      node.type === "ImportSpecifier" ||
      node.type === "ImportDefaultSpecifier" ||
      node.type === "ImportNamespaceSpecifier"
    )
      check(node.local);
    if (node.type === "TSTypeParameter") check(node);
    for (const [key, child] of Object.entries(node)) {
      if (
        key !== "loc" &&
        key !== "extra" &&
        key !== "comments" &&
        key !== "tokens"
      )
        visit(child);
    }
  };
  visit(tree);
}

// TS permits angle assertions that TSX does not. Check either valid grammar,
// rather than silently skipping a TS statement because the JSX parse failed.
function parseAuthoredSource(source: string, line: number, column: number) {
  const position = {
    sourceType: "module" as const,
    startLine: line,
    startColumn: column,
  };
  try {
    return parse(source, { ...position, plugins: ["typescript", "jsx"] });
  } catch {
    return parse(source, { ...position, plugins: ["typescript"] });
  }
}

/** Checks Marko statement tags before a host can reject or discard them. */
export function checkReservedTemplate(ctx: Ctx, body: Node[]): void {
  checkReservedBindings(body);
  const visit = (nodes: Node[]): void => {
    for (const node of nodes) {
      if (node.type !== "MarkoTag") continue;
      const name = node.name?.value;
      if (["import", "export", "static", "server", "client"].includes(name)) {
        let source = sliceLoc(ctx, node.loc);
        if (name === "static" || name === "server" || name === "client") {
          source = source.replace(/^(static|server|client)\b/, (keyword) =>
            " ".repeat(keyword.length),
          );
        }
        let parsed: Node;
        try {
          parsed = parseAuthoredSource(
            source,
            node.loc.start.line,
            node.loc.start.column,
          );
        } catch {
          // Existing statement/host validation owns malformed source. Never
          // treat an unparsed identifier substring as evidence of a binding.
          continue;
        }
        checkReservedBindings(parsed);
      }
      visit(node.body?.body ?? []);
      visit(node.attributeTags ?? []);
    }
  };
  visit(body);
}

/** Checks TypeScript source with its file-relative starting position. */
export function checkReservedSource(
  source: string,
  line = 1,
  column = 0,
): void {
  const file = parseAuthoredSource(source, line, column);
  checkReservedBindings(file);
}
