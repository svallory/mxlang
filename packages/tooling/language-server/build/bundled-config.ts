// The ONE definition of the language server's self-contained ("bundled")
// build: what it bundles, and which packages it leaves out. Read by
// `build/bundled.ts` (the build) and by `packages/editors/vscode/scripts/*`
// (the VSIX stage, its check and the LS smoke), so the externals exist in
// exactly one place.
//
// Not published: the npm tarball keeps the `@mxlang/*` packages external
// (`build` in package.json) and `files` stays `["dist", "README.md"]`. This
// output (`bundle/`) is a VSIX-only self-contained build.

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

/** Left external and NOT shipped. None: the server needs no project package. */
export const BUNDLED_PROJECT_RESOLVED = [] as const;

export const BUNDLED_EXTERNALS = [
  ...BUNDLED_INSTALLED,
  ...BUNDLED_PROJECT_RESOLVED,
] as const;
