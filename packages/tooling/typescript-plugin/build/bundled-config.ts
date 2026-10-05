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
 * closure): the plugin loads them at run time through `createRequire`, or they
 * read files next to themselves (`@astrojs/compiler`'s wasm), so they cannot
 * be inlined.
 */
export const BUNDLED_INSTALLED = [
  "@marko/compiler",
  "@astrojs/compiler",
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
