# @mxlang/tsc

## Unreleased

### Fixed

- **`dist/*.cjs` no longer bakes the build machine's path**: Bun inlines `import.meta.url` in CJS output, so every `createRequire(import.meta.url)` (the plugin, `@mxlang/angular-checker`, `typescript`) resolved from the tree that built the package, not from the installed one. `build` now defines `import.meta.url`, `__filename` and `__dirname` from the bundle's own location and fails if a `file:///` literal or the build root remains. `scripts/pack-probe.ts` also typechecks a `.mx` fixture with the packed `mx-tsc`.

- **Angular template diagnostics pick the same tsconfig as the TypeScript pass** (mx-tsc-tsconfig-resolution): `resolveProjectTsconfig` no longer re-implements `tsc`'s choice by hand; it runs TypeScript's own `parseCommandLine`/`findConfigFile`. So `-P`, `--PROJECT`, `@args.txt` response files and `-p` with a directory lacking `tsconfig.json` (no pick, as `tsc` fails with TS5057) agree; input files without `-p` use no tsconfig (was: the nearest one); `--project=<path>`, which `tsc` rejects (TS5023), is no longer honoured. `-b` resolves its projects (default `.`, no walk up) and the template pass runs once per project, in the order given, each over the `.ng.mx` files under that project's directory; before, `mx-tsc -b a b` only ever checked the templates of the last project.

- **The tarball ships only `dist/` and the README** (pkg-types-g10): `files` is now `["dist", "README.md"]`, so `src/`, the test fixtures and `moon.yml` (115 files) no longer ship. `types` is dropped: it pointed at `src/index.ts`, and `bun build` emits no declarations. Nothing imports `@mxlang/tsc` as a TypeScript module; the package is used through its `mx-tsc` bin. `scripts/pack-probe.ts` installs the packed tarball and runs `mx-tsc --version`.
