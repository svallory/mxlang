// The ONE definition of the language server's self-contained ("bundled")
// build: what it bundles, and which packages it leaves out. Read by
// `build/bundled.ts` (the build) and by `packages/editors/vscode/scripts/*`
// (the VSIX stage, its check and the LS smoke), so the externals exist in
// exactly one place.
//
// Not published: the dist build keeps core and parser external, but bundles
// the target registry and descriptors so their synchronous load() never
// depends on a global require in Node ESM. This VSIX build inlines every
// @mxlang/* package; only the externals below may remain outside the bundle.
// `files` stays ["dist", "README.md"], so bundle/ is VSIX-only.

/** `src/<entry>.ts` bundled to `bundle/<entry>.cjs`. */
export const BUNDLED_ENTRIES = ["bin"] as const;

/** Output dir, relative to the package, outside `files`. */
export const BUNDLED_OUTDIR = "bundle";

/** The executable the VSIX runs with VS Code's own Node. */
export const BUNDLED_MAIN = "bin.cjs";

/**
 * Left external AND shipped beside the server (copied with their dependency
 * closure): `@marko/compiler` loads its own translators and runtime files at
 * run time, so it cannot be inlined.
 */
export const BUNDLED_INSTALLED = ["@marko/compiler"] as const;

/**
 * Left external and NOT shipped: resolved from the user's project at run time.
 * `@angular/compiler` is an optional peer of `@mxlang/angular`, which reads
 * Angular's DOM schema from it through `createRequire(projectDir)`
 * (`hosts/angular/src/dom-schema.ts`); a missing one is a positioned error.
 */
export const BUNDLED_PROJECT_RESOLVED = ["@angular/compiler"] as const;

export const BUNDLED_EXTERNALS = [
  ...BUNDLED_INSTALLED,
  ...BUNDLED_PROJECT_RESOLVED,
] as const;
