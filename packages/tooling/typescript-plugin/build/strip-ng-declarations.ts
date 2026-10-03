/**
 * Strip the Angular worker-client declarations from `dist/` after tsc emits
 * them. `src/ng-diagnostics.ts` is imported by the entry, so tsc always emits
 * its declaration even though the tarball must not ship it: its types reach
 * `@mxlang/angular-checker` (a devDependency the tarball does not declare) and,
 * through it, `@angular/compiler-cli`. `src/ng-worker.ts` is excluded from the
 * declaration emit in `tsconfig.build.json` and normally produces nothing.
 *
 * The strip fails the build loudly if any declaration that would keep shipping
 * references a stripped module — parsed as module references (`import`/`export
 * … from`, bare `import`, `import()`/`require()`, `/// <reference path>`), with
 * every relative form resolved: this repo's emit retains `.ts` specifiers
 * (`allowImportingTsExtensions`), and `.js`, extensionless and `../` forms all
 * resolve to the same declaration file. Nothing is deleted when a reference is
 * found (pack-probe's `skipLibCheck:false` consumer probe would otherwise be
 * the first place a dangling import surfaced).
 *
 * Usage: `bun build/strip-ng-declarations.ts <distDir>`
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

/** Modules whose `.d.ts` must not ship (see the package's AGENTS.md). */
export const STRIPPED = ["ng-diagnostics", "ng-worker"];

/**
 * Module-reference syntaxes a declaration file can use to reach another
 * module. `from "…"` covers `import … from` and `export … from` (including
 * `export type … from`).
 */
const REFERENCE_PATTERNS: RegExp[] = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\/\/\/\s*<reference\s+path=["']([^"']+)["']/g,
];

function* declarationFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* declarationFiles(path);
    else if (entry.name.endsWith(".d.ts")) yield path;
  }
}

/**
 * The declaration files a module-reference specifier from `fromFile` can
 * resolve to. Only relative specifiers can reach the stripped files; `.ts`,
 * `.js`, extensionless and directory forms all map onto `*.d.ts` candidates.
 */
function referencedDeclarationFiles(
  specifier: string,
  fromFile: string,
): string[] {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return [];
  const target = normalize(resolve(dirname(fromFile), specifier));
  if (target.endsWith(".d.ts")) return [target];
  const base = target.replace(/\.(?:ts|tsx|js|mjs|cjs)$/, "");
  return [base + ".d.ts", join(base, "index.d.ts")];
}

/**
 * Every `dangling` reference: a shipped declaration (not itself stripped)
 * whose module references resolve to a stripped declaration file. Empty when
 * the strip is safe to run.
 */
export function findDanglingReferences(dist: string): string[] {
  const strippedPaths = new Set(
    STRIPPED.map((name) => normalize(join(dist, `${name}.d.ts`))),
  );
  const dangling: string[] = [];
  if (!existsSync(dist)) return dangling;
  for (const file of declarationFiles(dist)) {
    if (strippedPaths.has(normalize(file))) continue;
    const text = readFileSync(file, "utf8");
    for (const pattern of REFERENCE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1] ?? "";
        for (const target of referencedDeclarationFiles(specifier, file)) {
          if (strippedPaths.has(normalize(target))) {
            dangling.push(`${file}: ${specifier} -> ${target}`);
          }
        }
      }
    }
  }
  return dangling;
}

/** Remove the stripped declarations. Call only when no references remain. */
export function stripDeclarations(dist: string): void {
  for (const name of STRIPPED) {
    rmSync(join(dist, `${name}.d.ts`), { force: true });
  }
}

if (import.meta.main) {
  const dist = process.argv[2] ?? "dist";
  const dangling = findDanglingReferences(dist);
  if (dangling.length > 0) {
    console.error(
      "dist declarations reference a stripped Angular worker module; the " +
        "tarball would ship a dangling import (nothing was deleted):\n" +
        dangling.join("\n"),
    );
    process.exit(1);
  }
  stripDeclarations(dist);
}
