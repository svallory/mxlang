// The ONE definition of the plugin's self-contained ("bundled") build: what it
// bundles, and which packages it leaves out. Read by `build/bundled.ts` (the
// build) and by `packages/editors/vscode/scripts/*` (the VSIX stage and its
// check), so the externals exist in exactly one place.
//
// Not published: dist keeps core/parser external but bundles the registry,
// descriptors and host glue so synchronous load() works under plain Node.
// This VSIX build inlines every @mxlang/* package; only the externals below
// may escape. `files` stays ["dist", "README.md"], so bundle/ is VSIX-only.

/** `src/<entry>.ts` bundled to `bundle/<entry>.cjs`. */
export const BUNDLED_ENTRIES = ["index", "ng-worker"] as const;

/** Output dir, relative to the package, outside `files`. */
export const BUNDLED_OUTDIR = "bundle";

/**
 * Left external AND shipped beside the plugin (copied with their dependency
 * closure): `@astrojs/compiler` reads files next to itself (its wasm), so it
 * cannot be inlined, and the Babel packages are the ones `@mxlang/core`
 * requires at run time (`src/babel.ts`; decision 197, PR 6 slice S1). The
 * Marko parse layer is not here: it comes with `@mxlang/core`'s dist as
 * `marko-frontend.cjs` (decision 159), which `scripts/bundled-build.ts`
 * copies into the bundle directory.
 */
export const BUNDLED_INSTALLED = [
  "@astrojs/compiler",
  "@babel/code-frame",
  "@babel/core",
  "@babel/generator",
  "@babel/parser",
  "@babel/plugin-transform-typescript",
  "cosmiconfig",
] as const;

/**
 * Left external and NOT shipped: resolved from the user's project (the Angular
 * worker uses `createRequire(projectDir)`), handed over by tsserver
 * (`typescript`), or an optional peer (`@astrojs/language-server`).
 */
export const BUNDLED_PROJECT_RESOLVED = [
  "typescript",
  "@angular/compiler",
  "@angular/compiler-cli",
  "@astrojs/language-server",
] as const;

export const BUNDLED_EXTERNALS = [
  ...BUNDLED_INSTALLED,
  ...BUNDLED_PROJECT_RESOLVED,
] as const;
