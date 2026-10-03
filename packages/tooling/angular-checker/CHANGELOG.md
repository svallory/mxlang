# @mxlang/angular-checker

## Unreleased

- **Fix (angular-checker-dist-before-typecheck, the #182/#192 pattern):** `tsc --noEmit` now resolves `@mxlang/core`, `@mxlang/parser` and `@mxlang/angular` from their src via tsconfig `paths` (the parser to its hand-written `public.d.ts`), so the typecheck passes in a fresh checkout with no built `dist/` anywhere and can never read stale dependency types. `tsconfig.build.json` pins `rootDir: src` and clears the src mapping, so the tarball's declarations still resolve the deps through their published dist types. No emitted or runtime change.

- **Fix (angular-fix-hints, audit item 14):** NG8002 for a misspelled component input now suggests its uniquely nearest declared input, using Angular's matched metadata (including aliases, inherited inputs and signal inputs), not unrelated classes. When a suggestion exists, it replaces the generic schema-suppression advice. A bare event-handler reference taking two numbers now gets the concrete inline-arrow fix (`on-click=(() => two(1, 2))`) instead of TS assignability prose; other type errors are preserved. Codes, counts and authored positions stay unchanged, and tests apply each suggested fix and check the full emitted module clean.

### Changed

- **`typescript` is resolved from the user's project at run time**, the same way as `@angular/compiler-cli`, instead of being imported from the checker's own location. The forked worker gets no `ts` from tsserver and the VS Code extension ships none, so the bare import crashed the worker on start in an installed extension. A project without `typescript` gives the same one-per-project unavailable notice as a missing compiler-cli, naming `typescript`. `typescriptVersion` is no longer exported (it was a module-level constant of the bundled copy); use `resolveTypescript(projectDir).version`. New exports: `resolveTypescript`, `TypescriptModule`, `TypescriptResolution`.

### Fixed

- **`typescript` is a declared peer dependency** (`>=5.9.0 <7`, the repo's peer policy): `dist/*.d.ts` imports `typescript` but the package declared only `@angular/compiler-cli`, so a strict consumer got `TS2307`. Caught by `scripts/pack-hygiene.test.ts` after the checker's declarations started referencing the TypeScript API.
- **`typescript` is resolved from the resolved compiler-cli's own location first** (the instance compiler-cli itself loads), falling back to the project. This also finds it in strict layouts where the project does not depend on `typescript` directly. `resolveCompilerCli`'s ok result gains `packageJson`; `resolveTypescript` takes it as an optional second argument.
- **The tarball ships no `.d.ts.map` files** (pkg-types-g10): `tsconfig.build.json` turns `declarationMap` off (the maps pointed at unpublished `../src/*.ts`) and excludes `src/**/fixtures/**`.
