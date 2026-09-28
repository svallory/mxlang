import type { File } from "@babel/types";
import { parse as babelParse } from "../babel/index.ts";

/**
 * Solid JSX built-ins that resolve with no import of their own inside a
 * `.solid.mx` region, or on Solid's whole-file `.solid.mx` unit compile: the
 * *runtime* build pipeline gets these for free because `@solidjs/vite-plugin`'s
 * compiler stage (native or Babel) auto-imports every built-in it sees (see
 * `packages/hosts/solid/AGENTS.md`, "Solid 2 target and pin policy"). The
 * type-check projection (`@mxlang/typescript-plugin`'s `appendSolidBuiltinImport`)
 * and the resolvability check `@mxlang/solid`'s `isComponent` runs (decision
 * 114) both need this exact list, so it lives here once rather than twice.
 */
export const SOLID_BUILTIN_TAGS: ReadonlyArray<{
  name: string;
  from: string;
}> = [
  { name: "Show", from: "solid-js" },
  { name: "For", from: "solid-js" },
  { name: "Switch", from: "solid-js" },
  { name: "Match", from: "solid-js" },
  { name: "Repeat", from: "solid-js" },
  { name: "Errored", from: "solid-js" },
  { name: "Loading", from: "solid-js" },
  { name: "Dynamic", from: "@solidjs/web" },
];

/**
 * The names of every value a piece of TypeScript/TSX source text binds at
 * its top level — every import's *local* name (so `import { Show as MyShow }`
 * binds `MyShow`, not `Show`) plus every top-level `const`/`function`/`class`
 * declaration. A type-only binding never counts: neither `import type { X }`
 * nor `import { type X }` introduces a value named `X`, and `type`/`interface`
 * declarations are not collected at all (only `VariableDeclaration`,
 * `FunctionDeclaration` and `ClassDeclaration` are).
 *
 * Shared between `@mxlang/typescript-plugin` (`appendSolidBuiltinImport`,
 * deciding whether to inject a synthetic import for a Solid built-in) and
 * `@mxlang/solid` (`isComponent`, deciding whether a capitalized tag used
 * inside a `.solid.mx` region resolves through the *surrounding* module's own
 * scope — decision 114). Parses with the same Babel used elsewhere in this
 * package rather than scanning lines, since a line-based probe cannot tell a
 * bound identifier from a substring (an alias clause, a multi-line import).
 */
export function sourceBindings(source: string): Set<string> {
  try {
    return programBindings(
      babelParse(source, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
      }).program,
    );
  } catch {
    return new Set();
  }
}

/**
 * Same contract as `sourceBindings`, over an already-parsed `Program` rather
 * than raw source text. For a caller that already has one — a `.solid.mx`
 * file cannot be re-parsed with plain `typescript`/`jsx` plugins, since it
 * contains MX-only syntax (shorthand `class`/`#id`, object-literal
 * attributes) real TSX rejects; `@mxlang/parser`'s own
 * `collectModuleImportSpecifiers`-style declaration pre-pass (regions
 * replaced with `null`) is what produces a parseable `Program` for it.
 */
export function programBindings(program: File["program"]): Set<string> {
  const bound = new Set<string>();
  for (const statement of program.body) {
    switch (statement.type) {
      case "ImportDeclaration":
        if (statement.importKind === "type") break;
        for (const specifier of statement.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.importKind === "type"
          ) {
            continue;
          }
          bound.add(specifier.local.name);
        }
        break;
      case "VariableDeclaration":
        for (const declarator of statement.declarations) {
          collectPatternNames(declarator.id, bound);
        }
        break;
      case "FunctionDeclaration":
      case "ClassDeclaration":
        if (statement.id) bound.add(statement.id.name);
        break;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        if (
          statement.declaration &&
          (statement.declaration.type === "VariableDeclaration" ||
            statement.declaration.type === "FunctionDeclaration" ||
            statement.declaration.type === "ClassDeclaration")
        ) {
          if (statement.declaration.type === "VariableDeclaration") {
            for (const declarator of statement.declaration.declarations) {
              collectPatternNames(declarator.id, bound);
            }
          } else if (statement.declaration.id) {
            bound.add(statement.declaration.id.name);
          }
        }
        break;
      default:
        break;
    }
  }
  return bound;
}

/**
 * Collects every identifier a binding pattern introduces — a bare name, or
 * the names inside a destructured object/array — so a top-level
 * `const { Show } = ...` is recognized as binding `Show` the same as a plain
 * `const Show = ...` would. Untyped on purpose: the pattern shapes are a
 * small, stable subset of Babel's AST and pulling in `@babel/types` just for
 * this helper's signature is not worth a new dependency.
 */
// biome-ignore lint/suspicious/noExplicitAny: small stable subset of Babel's pattern node shapes
function collectPatternNames(pattern: any, bound: Set<string>): void {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      bound.add(pattern.name);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        if (property.type === "ObjectProperty") {
          collectPatternNames(property.value, bound);
        } else if (property.type === "RestElement") {
          collectPatternNames(property.argument, bound);
        }
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        collectPatternNames(element, bound);
      }
      break;
    case "AssignmentPattern":
      collectPatternNames(pattern.left, bound);
      break;
    case "RestElement":
      collectPatternNames(pattern.argument, bound);
      break;
    default:
      break;
  }
}
