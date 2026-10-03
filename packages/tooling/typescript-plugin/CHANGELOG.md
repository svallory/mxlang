# @mxlang/typescript-plugin

## 0.1.0 (unreleased)

### Changed: `.amx` is now `.astro.mx` (amx-to-astro-mx, decision 134)

The AstroMX language plugin claims `.astro.mx` instead of `.amx`, with no alias, and the `.mx` plugin declines `x.astro.mx` as it declines `.solid.mx` and `.ng.mx`. The diagnostic `source` string for these files is `astromx` (it was `amx`). `createAmxLanguagePlugin` and the module name keep `amx`.

### Added: host-policy diagnostics (host-policy-diagnostics-tsc-tsserver)

An unknown `mx.host` or a malformed `package.json` was silent in tsserver (the file just got the fallback host). Every language plugin now records what `resolveHostPolicyDetailed` said for each file it compiles, per plugin instance (`getHostPolicyDiagnostics(fileName?)`), and tsserver reports it as a `TS80003` warning on that file at 1:1, naming `package.json:line:col` (tsserver reports no diagnostics on a `package.json`). `mx-tsc` prints the same records positioned in the `package.json`. New exports: `HOST_POLICY_DIAGNOSTIC_CODE`, `hostPolicyMessage`, type `HostPolicyDiagnostic`. The text is the language server's (`<package.json>:line:col: <message>`, the path said once; `hostPolicyText` is the message without core's leading path), and `source` follows the file kind (`mx`, `solidmx`, `ngmx`, `amx`). Known limit: the plugin does not watch `package.json`, so a fixed manifest clears the warning only once the `.mx` is edited or the project reloads.

### Fixed: a failed `.mx` compile no longer cascades `TS2306 … is not a module` into every importer

When a template failed to compile, its virtual module was the empty string. Every importer then reported `TS2306 File '…/x.mx' is not a module`, which `mx-tsc` printed first, at the importer, before the real compile error (a reader went to the wrong file; 21 of 21 compile-error cases in the agent-feedback audit). The virtual module is now a typed stub (`failed-module-stub.ts`): an `any` default export, an `Input` type, and every name the failed source itself exports, each declared as both a value and a type. Default, named, `import type` and `import * as` imports all resolve, so the real compile error is the only diagnostic for the ordinary import and usage forms (see `AGENTS.md` for the known limits: unscanned names and `TS7006` on callbacks passed to a stubbed value's methods). Applies to `.mx`, `.amx`, `.solid.mx` and `.ng.mx`, on both the syntax-error and the foreign-template-error paths.

### Fixed: the plugin's builds no longer bake the build machine's path

`dist/index.cjs` and the VSIX `bundle/` contained `createRequire("file:///<build tree>/...")` (Bun inlines `import.meta.url` in CJS output), so the plugin loaded `@marko/compiler`, `@mxlang/core`'s dependencies and the Angular worker from the machine that built it. `build` and `build:bundled` now define `import.meta.url`, `__filename` and `__dirname` from the bundle's own location, and fail if a `file:///` literal or the build root remains.

### Changed: `build/bundled.ts` uses the shared `scripts/bundled-build.ts`

The `Bun.build` call moved to the repo-root `scripts/bundled-build.ts`, shared with the language server's own bundled build. The output is unchanged.

### Added: a VSIX-only self-contained build (`build:bundled`)

`bun run build:bundled` writes `bundle/` (gitignored, outside `files`): the plugin and the Angular worker with `@mxlang/*`, volar and babel inlined, `cjs-factory` applied, and the entries and externals taken from one list (`build/bundled-config.ts`). The VS Code extension copies it into its VSIX. `build/cjs-factory.ts` now exports `applyCjsFactory(entry)`. The npm tarball, `files` and the public exports are unchanged.

### Fixed: tsserver loads the plugin (CJS `module.exports` is the factory)

Before this fix, tsserver skipped `@mxlang/typescript-plugin`, so none of its features (`.solid.mx`/`.mx`/`.ng.mx`/`.amx` language support, the diagnostics it injects) loaded in VS Code or any other tsserver editor. `dist/index.cjs` exported the module namespace as an object (`{ default: pluginFactory, ...named }`); tsserver loads a plugin with a plain `require()` and only proceeds when the result is a function, so `Project.enableProxy` logged "did not expose a proper factory function" and moved on. The build now appends `module.exports = Object.assign(module.exports.default, module.exports)` (guarded on `.default` being a function) to `dist/index.cjs` (`build/cjs-factory.ts`): `require()` returns the factory itself, and `default` and every named export are still there. Additive: no export is removed or renamed, and the ESM entry and `dist/index.d.ts` are unchanged. Covered by `src/cjs-factory.test.ts` (loads the built entry through `ts.sys.require`, as tsserver does) and `src/tsserver-load.test.ts` (one real tsserver loads the plugin and serves a plugin-only diagnostic).

### Fixed: the package ships declarations, not source (ts-plugin-declarations)

`types` pointed at `src/index.ts` and there was no `files` field, so a tarball carried `src/`, tests and fixtures, and the types resolved only because the source did. `bun run build` (and the moon `build` task, which now delegates to it) now emits `dist/*.d.ts` with `tsc -p tsconfig.build.json --emitDeclarationOnly`, `types` is `dist/index.d.ts` and `files` is `["dist", "README.md"]`. The public surface is unchanged: `dist/index.d.ts` exports exactly what `src/index.ts` does. `@mxlang/tsc` typechecks against the plugin's `src` through a tsconfig `paths` mapping, so no typecheck needs a prebuilt dist. `scripts/pack-hygiene.test.ts` and `scripts/pack-probe.ts` now cover the plugin.

### Added: `retainCompiled` for `.ng.mx`

`createNgMxLanguagePlugin` takes `{ retainCompiled: true }` and exposes `getCompiledNgMx()`, the latest successful compile of each `.ng.mx` file (a file whose latest compile failed is absent). Off by default, so an editor session does not hold every compile; `mx-tsc` turns it on to run Angular template diagnostics over the compiles its type-check used. No change to the editor path.

### Added: `.ng.mx` is its own file kind (`createNgMxLanguagePlugin`)

A `.ng.mx` file is no longer compiled as a whole-file `.mx` page. `createNgMxLanguagePlugin` (language id `ngmx`) compiles it with `compileNgMx` from `@mxlang/angular` and hands Volar the emitted TypeScript module, so TypeScript semantics (class, imports, decorators) are reported at the right `.ng.mx` line and column. Text outside the `template:` regions maps through the module's source map; each template expression maps through `result.mappings`. TypeScript sees a region as an opaque template literal, so template-expression checking is not part of this (it needs Angular's compiler). `isMx` excludes `.ng.mx` by core's `hostModuleSegment`; the host-policy guard for Angular `.mx` pages is unchanged. An invalid `package.json#mx.angular` is reported as an error positioned at the start of the `.ng.mx` file instead of throwing or defaulting.

### Fix: whole-file Solid `.mx` component props are type-checked (solid-whole-file-prop-typing)

The virtual code for a whole-file Solid `.mx` is `compileSolidUnit`'s output, which now keeps `export interface Input` and annotates `function Card(input: Input)`. A wrong ordinary prop at the caller is TS2322 at the attribute, a missing required prop TS2741; correct calls, optional props, AttrTag props and a component with no `Input` stay clean. No plugin code changed.

### Fix: `appendSolidBuiltinImport` no longer silently under-imports on a printer parse failure (source-bindings-silent-parse-failure)

`appendSolidBuiltinImport` decides which Solid JSX built-ins (`Show`/`For`/…) need a synthetic import by checking `@mxlang/parser`'s `sourceBindings` against the *generated* TSX text — never author-facing source. `sourceBindings` used to catch a parse failure silently and return an empty binding set indistinguishable from "genuinely binds nothing," so a printer bug that ever emitted invalid TSX would make this function under-import: exactly the failure class it exists to prevent (a free `Show`/`For` reference hiding every real diagnostic behind TS2304). `sourceBindings` now reports `{ bindings, error? }`; on `error`, `appendSolidBuiltinImport` appends every referenced built-in unconditionally (safe over-inclusion) and returns a positioned `MxWarning` (line 1, column 0) instead of guessing from an empty set. Its caller (`createSolidMxLanguagePlugin`) merges that warning into the same `compileDiagnostics` array the cap warning already uses, so it reaches the editor as a real diagnostic instead of only a `console.warn`.

### Fix: `compileWithDependencies` warns when it hits the pass cap without settling (compile-deps-cap-warning)

`compileWithDependencies` (`src/language.ts`) reaching `MAX_COMPILE_PASSES` (8) without a dependency set/source fixed point used to return its last result silently — a caller's virtual code was typed against whatever the final pass happened to see, with no signal that the loop gave up rather than converged. It now pushes an `MxWarning` onto `result.warnings` (when the generic result type carries one) naming every dependency discovered across the unsettled chain, positioned at the file's own start (line 1, column 1). `mx-language.ts`, `amx-language.ts`, and `language.ts`'s own `createSolidMxLanguagePlugin` already destructure `warnings` from every `compileWithDependencies` result unconditionally, so the warning reaches `getCompileDiagnostics` — and the editor/`mx-tsc` — through the existing warning path with no caller-side change.

Round 2 (review): the loop's fixed-point check only validated compiles #1 through #7 (each checked against the *previous* pass at the top of the *next* iteration), never the 8th and final compile — so a chain that discovered a new dependency every pass through #7 and then genuinely settled on #8 got a false-positive warning anyway. Fixed by re-running the same settle check once more against the final result before deciding to warn. Also added `src/compile-deps-cap-warning.test.ts`, a dedicated file (so its `vi.mock("@mxlang/preact", …)` can't leak elsewhere) proving the cap warning reaches `getCompileDiagnostics` through a real caller (`createMxLanguagePlugin`) end to end — a real `AttrTag<Alias>` chain can't organically reach the literal cap (`readCalleeInput`'s own `MAX_ALIAS_DEPTH`, 4, bounds a single compile independently of this loop's pass count), so only the dependency-discovery step is stood in for; `compileWithDependencies` itself and the caller's warnings-to-diagnostics plumbing run for real.

### Fix: whole-file Solid `.mx` now routes through `compileSolidUnit`, not the region compiler (decision 115)

`createMxLanguagePlugin`'s `compileMxVirtual` (`src/mx-language.ts`) called `compileSolidMx` — the `.solid.mx` *region* compiler, which unconditionally rejects any module-level statement — for `host === "solid"` regardless of whether the file was a whole-file `.mx` or a `.solid.mx` region, even though `compileSolidMx` was never meant for the whole-file path. A whole-file `.mx` resolved to Solid with an authored `import` therefore failed to compile in the editor with "module-level MX statements cannot appear inside a `.solid.mx` expression" — the actual bug behind TODO `solid-whole-file-mx-import` (filed from PR #149). Now calls `compileSolidUnit`, the whole-file entry point, which places an authored `import`/`static`/`export` in the generated module instead of rejecting it. `.solid.mx` regions (`createSolidMxLanguagePlugin` in `src/language.ts`) are unaffected — that path correctly used `compileSolidMx` already and still does.

### Fix: `compileWithDependencies` iterates to a fixed point instead of stopping after one retry (compile-with-dependencies-nesting-limit)

`compileWithDependencies` (`src/language.ts`) used to run at most one retry: the first pass used the sources of the previously reported dependencies, and a changed dependency set triggered exactly one more pass. A dependency chain deeper than that — a callee's `AttrTag<Alias>` (the whole type argument) itself aliasing a type `import type`-ed from a further file, which `readCalleeInput`'s own `resolveNamedType` follows across files independently of this loop — could have its deepest hop discovered only by the retry's own compile, with no further pass to read it fresh. The caller then stayed typed against that file's stale or absent text.

`compileWithDependencies` now loops until a pass reports the same dependency set as the pass before it, or a newly reported dependency has no host text different from what a previous pass already read for it, accumulating every pass's sources rather than replacing them — capped at 8 passes (`MAX_COMPILE_PASSES`) so a dependency cycle (A depends on B depends on A) or a pathological chain still terminates. The existing single-hop semantics are unchanged: no reader still means one compile, and a host holding nothing new for a changed dependency set still stops without a retry.

Measured: the nested-field-reference attribute-tag shape (`AttrTag<{ attrs: Alias }>`, as opposed to `AttrTag<Alias>`) is not subject to this at all — that type is never added to `ctx.dependencies`, and is instead resolved entirely through the emitted `satisfies NonNullable<Parameters<typeof Callee>[0]["tag"]>` reference, which TypeScript's own live module graph re-checks on every edit (decision 107, option A) regardless of this function.

### Internal: shared `sourceBindings`/`SOLID_BUILTIN_TAGS` with `@mxlang/parser` (decision 114)

`language.ts`'s `sourceBindings` and `SOLID_BUILTIN_IMPORTS` (used by `appendSolidBuiltinImport`, the synthetic-import injector for Solid's virtual code projection) moved to `@mxlang/parser` as `sourceBindings`/`programBindings` and `SOLID_BUILTIN_TAGS`, now also used by `@mxlang/solid`'s tightened `isComponent` (decision 114) — one implementation instead of two that could drift. No behavior change here; `appendSolidBuiltinImport`'s own contract is unchanged.
