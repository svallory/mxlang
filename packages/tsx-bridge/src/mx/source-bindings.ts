import type { File } from "@babel/types";
import { isFunctionLikeValue } from "@mxlang/core";
import { parse as babelParse } from "@mxlang/babel";

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

/** A `sourceBindings` parse failure, positioned in the source it was given. */
export interface SourceBindingsError {
  message: string;
  line: number;
  column: number;
}

/**
 * Grammar relaxations a caller may need for the source it hands over.
 *
 * `allowReturnOutsideFunction` is for authored host module scope that the
 * *host* wraps in a function body, where a top-level `return` is legal source:
 * Astro's `---` frontmatter is compiled into the body of the component's
 * `$$render` (or a redirect handler), so `return Astro.redirect("/")` is
 * ordinary Astro. A plain ES module — every `.solid.mx`/`.ng.mx`/`appendSolid-
 * BuiltinImport` caller here — has no such wrapper, so the default stays
 * off and a stray `return` there is still the syntax error it is today.
 */
export interface SourceBindingsOptions {
  allowReturnOutsideFunction?: boolean;
}

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
 * `@mxlang/astro` (`lowerAstroMx`, deciding whether a capitalized tag
 * resolves through the `---` fence's own scope — decision 114). Parses with
 * the same Babel used elsewhere in this package rather than scanning lines,
 * since a line-based probe cannot tell a bound identifier from a substring
 * (an alias clause, a multi-line import).
 *
 * **A parse failure is reported, not swallowed** (`source-bindings-silent-
 * parse-failure`, filed from the PR #156 review): before, a syntax error in
 * an Astro fence or the text handed to `appendSolidBuiltinImport` made this
 * function return an empty set indistinguishable from "genuinely binds
 * nothing," so every capitalized tag in that file misreported as
 * `rejectUnknownTag`'s "Unable to find entry point for custom tag" —
 * plausible-sounding, and wrong: the real problem was the syntax error, never
 * surfaced. `bindings` is always returned (empty on failure, exactly as
 * before, so an existing caller that ignores `error` keeps today's
 * behavior); `error` is set only on a parse failure, positioned from Babel's
 * own `SyntaxError.loc` (1-based line, 0-based column, matching every other
 * position this codebase reports), so a caller that cares can report the
 * real problem instead of a misleading downstream symptom.
 */
export function sourceBindings(
  source: string,
  options: SourceBindingsOptions = {},
): {
  bindings: Set<string>;
  error?: SourceBindingsError;
} {
  try {
    return {
      bindings: programBindings(
        babelParse(source, {
          sourceType: "module",
          plugins: ["typescript", "jsx"],
          ...(options.allowReturnOutsideFunction
            ? { allowReturnOutsideFunction: true }
            : {}),
        }).program,
      ),
    };
  } catch (cause) {
    const loc = (cause as { loc?: { line: number; column: number } }).loc;
    return {
      bindings: new Set(),
      error: {
        message: (cause as Error).message,
        line: loc?.line ?? 1,
        column: loc?.column ?? 0,
      },
    };
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
 * The subset of `programBindings`' *non-import* names (a top-level
 * `const`/`function`/`class`) whose value is not statically a function/
 * arrow/class — the local extension of decision 116 (firstmate's ruling
 * under decision 116 in `notes/decisions-2026-09-10.md`). An import
 * binding is never included here regardless of what it resolves to: decision
 * 116's own import-scoped classification (`ctx.importDefaultFromMarkoOrMx`)
 * already governs those, on a separate channel this function does not
 * duplicate.
 *
 * `function Foo(){}`/`class Foo{}`/`const Foo = () => {}` are the "known"
 * cases and are left out of the returned set; `const Foo = lazy(...)`, a
 * conditional, a string, or anything else opaque is "unknown" and included.
 * Destructured declarators (`const { Foo } = ...`) bind no single value
 * expression to classify and are left out entirely, matching
 * `@mxlang/core`'s own `<const>` handling.
 */
export function unknownProgramBindings(program: File["program"]): Set<string> {
  const unknown = new Set<string>();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (!declaration || declaration.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id?.type !== "Identifier") continue;
      if (isFunctionLikeValue(declarator.init)) continue;
      unknown.add(declarator.id.name);
    }
  }
  return unknown;
}

/**
 * Same contract as `unknownProgramBindings`, over raw source text — the
 * `sourceBindings` counterpart.
 */
export function unknownSourceBindings(
  source: string,
  options: SourceBindingsOptions = {},
): Set<string> {
  try {
    return unknownProgramBindings(
      babelParse(source, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
        ...(options.allowReturnOutsideFunction
          ? { allowReturnOutsideFunction: true }
          : {}),
      }).program,
    );
  } catch {
    return new Set();
  }
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
