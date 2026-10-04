import { type ParserOptions, parse } from "@babel/parser";
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
      case "Identifier": {
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
    // A type-only name cannot collide with emitted code: the type-check
    // preamble's generated families use a capital `__Mx…`, and no value
    // binding is minted from a type parameter. `declare function f(__mxA)`
    // is the same case: its parameters exist only in the type.
    const skipParams = node.type === "TSDeclareFunction";
    // The parser stamps lowered MX regions. Core already checks their authored
    // bindings; walking the generated replacement would reject our own helpers.
    if (node.extra?.mx) return;
    if (node.type === "MarkoTag") check(node.var);
    if (Array.isArray(node.params) && !skipParams)
      for (const p of node.params) check(p);
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
    for (const [key, child] of Object.entries(node)) {
      if (
        key !== "loc" &&
        key !== "extra" &&
        key !== "comments" &&
        key !== "tokens" &&
        !(skipParams && key === "params")
      )
        visit(child);
    }
  };
  visit(tree);
}

/**
 * Marko 6.3.51's own `parserOpts.plugins` (`babel-plugin/index.js`'s
 * `manipulateOptions`), so a statement this host's parser accepts is a
 * statement this checker can also read. `decorators` is what a decorated
 * `static @d() class C {}` or `@d() m() {}` needs: Marko accepts both through
 * its own Babel 8 build, and without the plugin here the reparse threw and
 * the tag was skipped — a silent false negative, never a false reject.
 */
const MARKO_PLUGINS = [
  "objectRestSpread",
  "classProperties",
  "decorators",
  ["typescript", { disallowAmbiguousJSXLike: false, dts: false }],
] as const satisfies NonNullable<ParserOptions["plugins"]>;

// TS permits angle assertions that TSX does not. Check either valid grammar,
// rather than silently skipping a TS statement because the JSX parse failed.
function parseAuthoredSource(source: string, line: number, column: number) {
  const position = {
    sourceType: "module" as const,
    startLine: line,
    startColumn: column,
  };
  try {
    return parse(source, {
      ...position,
      plugins: [...MARKO_PLUGINS, "jsx"],
    });
  } catch {
    return parse(source, { ...position, plugins: [...MARKO_PLUGINS] });
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

/**
 * Checks TypeScript source with its file-relative starting position.
 *
 * The one caller outside core is the Astro fence check, whose frontmatter is
 * authored text rather than an already-parsed tree: it needs the file's real
 * starting line, and reparsing with core's own grammar keeps one plugin list
 * (and therefore one reservation) across every authored region.
 */
export function checkReservedSource(
  source: string,
  line = 1,
  column = 0,
): void {
  checkReservedBindings(parseAuthoredSource(source, line, column));
}
