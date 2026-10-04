# @mxlang/angular-checker

## Unreleased

- **Clarification (hint-followups round 2):** the metadata cache speeds only repeated checks of the same entry with unchanged sources, compiler options and resolution evidence (CLI/batch rechecks or repeated tool calls). Editing a source or alternating entries rebuilds the single slot; this is not an editing-performance improvement. One extra full metadata Program is retained per checker until replacement or `dispose()` (approximately 65 MB additional heap in the reviewer's 150-component probe; workload-dependent). The cache is not widened.

- **Fix (ng-input-hint-metadata-program):** NG8002 input hints reuse a per-checker metadata-only program across unchanged checks. Source reads (including imported and virtual modules), resolution evidence (package manifests, missing candidates, symlinks and directory lookups), entry path and compiler options invalidate it by content, never mtime alone; disposal releases it. Changing package exports is detected even when the set of source files stays identical. The diagnostic program remains separate. An upgrade-contract test names `_enableTemplateTypeChecker`, `getTemplateTypeChecker`, `getTemplate` and `getDirectivesOfNode` explicitly if compiler-cli drops them.

- **Fix (ng-mx-tags-call-ts991010):** the compiler host serves in-memory Angular tag modules when a component imports their generated siblings, even before `mx-angular build` has written them. Calling a `tags/` component no longer produces misleading `TS-991010` and hides all the caller's template diagnostics. Tag sources are reread on each check; ordinary TS files keep their own contents.

- **Fix (angular-checker-dist-before-typecheck, the #182/#192 pattern):** `typecheck` now runs `tsc -p tsconfig.typecheck.json`, which resolves `@mxlang/core`, `@mxlang/parser` and `@mxlang/angular` from their src via `paths` (the parser to its hand-written `public.d.ts`), so the typecheck passes in a fresh checkout with no built `dist/` anywhere and can never read stale dependency types. The mapping lives outside `tsconfig.json` because Bun's bundler honours it and the typescript-plugin VSIX bundle inlines this package's src. `tsconfig.json`/`tsconfig.build.json` are unchanged, so the tarball's declarations still resolve the deps through their published dist types. No emitted or runtime change.

- **Fix (angular-fix-hints, audit item 14):** NG8002 for a misspelled component input now suggests its uniquely nearest declared input, using Angular's matched metadata (including aliases, inherited inputs and signal inputs), not unrelated classes. When a suggestion exists, it replaces the generic schema-suppression advice. A bare event-handler reference taking two numbers now gets the concrete inline-arrow fix (`on-click=(() => two(1, 2))`) instead of TS assignability prose; other type errors are preserved. Codes, counts and authored positions stay unchanged, and tests apply each suggested fix and check the full emitted module clean.

### Changed

- **`typescript` is resolved from the user's project at run time**, the same way as `@angular/compiler-cli`, instead of being imported from the checker's own location. The forked worker gets no `ts` from tsserver and the VS Code extension ships none, so the bare import crashed the worker on start in an installed extension. A project without `typescript` gives the same one-per-project unavailable notice as a missing compiler-cli, naming `typescript`. `typescriptVersion` is no longer exported (it was a module-level constant of the bundled copy); use `resolveTypescript(projectDir).version`. New exports: `resolveTypescript`, `TypescriptModule`, `TypescriptResolution`.

### Fixed

- **`typescript` is a declared peer dependency** (`>=5.9.0 <7`, the repo's peer policy): `dist/*.d.ts` imports `typescript` but the package declared only `@angular/compiler-cli`, so a strict consumer got `TS2307`. Caught by `scripts/pack-hygiene.test.ts` after the checker's declarations started referencing the TypeScript API.
- **`typescript` is resolved from the resolved compiler-cli's own location first** (the instance compiler-cli itself loads), falling back to the project. This also finds it in strict layouts where the project does not depend on `typescript` directly. `resolveCompilerCli`'s ok result gains `packageJson`; `resolveTypescript` takes it as an optional second argument.
- **The tarball ships no `.d.ts.map` files** (pkg-types-g10): `tsconfig.build.json` turns `declarationMap` off (the maps pointed at unpublished `../src/*.ts`) and excludes `src/**/fixtures/**`.
