# @mxlang/typescript-plugin

## Unreleased

- **Fix (unmapped-diagnostics-region-enclosing-spans, decision 161):** every built-in file kind now exposes its authored spans, so an unmappable diagnostic in a region file (`.solid.mx`, `.preact.mx`, `.react.mx`, `.hono.mx`), `.astro.mx` or `.ng.mx` lands on its enclosing tag or attribute with `(position approximate: generated <line>:<col>)`, not at 1:1 with `(position unknown in this file kind: …)`. New `regionAuthoredSpans`, `ngRegionSource` and a `baseOffset` parameter on `markoAuthoredSpans` (`authored-spans.ts`); `(position unknown …)` remains only for a failed module's stand-in and a kind whose language plugin sets no `authoredSpans`.

- **Fix (unmapped-diagnostics-never-dropped, decision 161):** a diagnostic with no source mapping is reported, not dropped: `approximateUnmapped` (new, exported with `approximateUnmappedDiagnostics`) runs beneath Volar's mapping in the tsserver plugin and `mx-tsc`, reporting it on the nearest enclosing tag or attribute (else 1:1) and appending `(position approximate: generated <line>:<col>)`, `(position unknown in this file kind: generated <line>:<col>)` (`unknownPositionSuffix`, a kind with no authored spans) or, only when the author spelled none of it, `(in MX-generated code, not yours: an MX bug; generated <line>:<col>)` per diagnostic range; placement does not depend on the order diagnostics arrive in, and a call's diagnostics are placed as one batch (each virtual code read once, Volar's lookup tables rebuilt once; `authoredSpans()` memoized per virtual code). Only files compiled from MX are touched: a plain `.astro` page's diagnostics are left to Volar. `relatedInformation` entries and `program.emit` diagnostics too. `SpannedVirtualCode.authoredSpans` lets a language plugin say which tags, attributes and code (`AuthoredSpan.kind`) its source holds. A diagnostic a mapping's `verification` hides on purpose (the `.astro.mx` fence's TS1108) and an exactly mapped one are unchanged.

- **Tests (render-consumers, decision 155):** `tsserver-load.test.ts` pins the signature wording of an html unit's default export in diagnostics again (reverts PR 1's `typeof Comp`).

- **Fix (mx-tsc-astro-ambient-types):** the tsserver plugin adds the hosts' ambient declaration files to the project (`withAmbientTypes` over `getScriptFileNames`), the same files `mx-tsc` adds: with `{ astro: true }`, `Fragment` resolves in `.astro` and `.astro.mx` files without `types: ["astro/env"]`. New exports `ambientTypeFiles(rootNames, projectDir)` (asks every host of the project's lookup, a loaded third-party host included; package files resolve from the project, then from the plugin's install; names no host) and `withAmbientTypes`.

- **Fix (astro-mx-custom-tag-tsx):** an `.astro.mx` page that calls a custom tag no longer projects to unparsable TSX (`TS1005 '>' expected`). The cause was upstream of the projection: `@mxlang/astro` lowered the tag to a `$`-led import (`$mx_Badge1`), which Astro treats as an HTML element, so `convertToTSX` rewrote its `/>` and Astro's own compiler shipped the literal `<$mx_Badge1 />`. The host now emits an upper-case-led binding (`Mx_Badge1`), so runtime and projection agree and the projection needs no swap.

- **Tests (third-party-data-host, decision 148):** a third-party host on the data target (`.mesh.mx`) is claimed as a whole-file `.mx`, compiles through the host's descriptor and reports data's errors at their offset. No code change.

- **Fix (reserve-mx-identifiers):** a `TranslateError` carrying a position but no Babel `loc` — the Solid and Angular module-binding paths, including the reserved-`__mx` diagnostic — now lands at its real line and column instead of offset 0. Errors that already carry a Babel `loc` are unchanged.

## 0.1.0 (unreleased)

- **Changed (bridge-host, decision 154):** one region language plugin per registered region file kind (`createRegionLanguagePlugin`, `createRegionLanguagePlugins`); `createSolidMxLanguagePlugin` is the first built-in region kind's. A region kind's `completeTypecheckModule` runs on its printed module, so Solid's built-in imports (`appendSolidBuiltinImport`, moved to `@mxlang/solid`) are Solid's hook, not a step every region file takes. `moduleFileExtensions()` lists the module file kinds `mx-tsc` checks. Output unchanged. A region plugin claims its own kind's suffix directly, case-insensitively as before (Volar keys files case-insensitively where the filesystem is), but turns the MX grammar on only for the exact-case suffix, so `X.SOLID.mx` is claimed and parsed as plain TSX exactly as at base (the language server, Vite and the registry treat it as whole-file `.mx`). The fallback syntax-error text names the file's own suffix, so a region kind other than Solid names its own (`.solid.mx`'s text is unchanged). Regions compile through the registry's `regionKindCompile`.

- **Tests (name-sugar-tooling r2):** the mid-edit buffers assert exactly one compile diagnostic with an in-range offset.

- **Tests/Docs (name-sugar-tooling, decision 146 PR 3):** the plugin builds its virtual code for a buffer mid-edit on a sugar sigil (`<input :`, `<input #`, `<input .`), and a sugar token maps to the generated `name`/`class`/`id` with its exact source range (documented on the TypeScript page).

### Fixed: no TS1108 for a top-level return in an `.astro.mx` `---` fence (astro-fence-top-level-return)

A fence `return` is valid Astro, but `convertToTSX` emits the frontmatter at the top level of a TSX module, ahead of the generated component function, so TypeScript reported `1108 A 'return' statement can only be used within a function body` for a page the build accepts. `createAmxLanguagePlugin` now implements a new optional `filterSemanticDiagnostics` on `MxDiagnosticLanguagePlugin`, and the tsserver language-service proxy applies it, so the editor no longer flags a valid fence.

The suppression is deliberately narrower than Astro's own language tools, which drop *every* 1108 in a `.astro` file: only TS1108 whose offset falls inside the fence is dropped, so a real error past the fence and ordinary type checking of the fence (TS2322 and friends) are untouched. The filter works in source offsets because both callers reach it after Volar has mapped a diagnostic back into the author's file.

`mx-tsc --astro` still reports it: Volar's `runTsc` rewrites TypeScript's own source so `createProgram` is a local binding, and `proxyCreateProgram` then decorates that program in place, so nothing `mx-tsc` owns ever sees the program. `packages/tooling/tsc/src/astro-fence-return.test.ts` pins the gap with `it.fails`; closing it needs a Volar diagnostics seam or a filter on `mx-tsc`'s own reporter, both above this package.

- **Fix (default-tag-ladder r2):** an invalid `defaultTag` is no longer reported as `target not loaded` on every file; its `package.json` diagnostic carries the error.

- **Added (default-tag-ladder, decision 145):** the package's `defaultTag` reaches the page compile, the mapping pass (`createHtmlMappings` takes a trailing `defaultTag`, so the second lowering agrees with the compile) and the `.solid.mx`, `.ng.mx` and `.astro.mx` pipelines.

### Test: offsets after an escaped text character map to the shifted generated positions (jsx-text-lt-unescaped)

`createSolidMxLanguagePlugin`'s mappings pin that `${input.zed}` after authored text `a < b` — emitted as `a &#60; b`, three characters longer — maps source offset 23 to generated offset 26, and the following statement (`const n: number = 1;`) maps source 41 to generated 44. The row guards the entity-expansion shift so a diagnostic after an escaped character lands on the authored text, not three columns late. No plugin code changed.

### Fixed: no page compile after a target load failure (registration PR 7 round 3)

When the policy carries `target-not-found`, `target-load-failed`, `target-invalid-descriptor` or `host-invalid-descriptor`, the plugin compiles nothing: it reports TS80003 and the `target not loaded: see package.json(line,col)` pointer over an inert virtual module, as the language server does, instead of the fallback target's verdict on the page. mx-tsc inherits this.

### Fixed: no html second lowering for a loaded target without declarations (registration PR 7 round 2)

A target loaded from a package specifier that declares no `declarations` maps from the mappings and source map its `compileModule` returns (or none) instead of being re-lowered under html's rules, which rejected pages the target accepts (an event handler, `<let>`). Built-in targets are unchanged.

### Added: third-party targets (registration PR 7)

The page compile, the mapping pass and tag discovery use the project's lookup (`lookupFor(policy)`), so a target a package specifier under `mx.target` / `mx.host` loaded compiles like a built-in one. A failed load is `TS80003` at the key's value plus the existing `TS80001` pointer `target not loaded: see package.json(line,col)` on the page. `createHtmlMappings` takes an optional trailing `targets` lookup (default: the built-in one).

### Fixed: `dropOwnLocationHeader` recognises relative, symlinked and CRLF spellings (no-repeat-path-relative-spellings)

The `at <path>:L:C` line is dropped when it names the diagnosed file. The comparison used to be lexical `resolve` of both strings, so a relative `fileName` spelled differently from Marko's cwd-relative path, a symlinked spelling on either side, or a CRLF message (the trailing `\r` defeated the line regex) kept the repeat. Both sides are now compared by `resolve` and `realpathSync` (guarding a missing file), and the line regex tolerates a trailing `\r`. Round 2: the `at` line is matched on a VT-stripped copy, so a kleur-coloured header under `FORCE_COLOR` reaches the identity comparison too; kept lines retain their original text. Generic path logic only (decision 126); still fail-safe — a spelling that matches nothing is kept, never dropped falsely.

### Fixed: Angular tag calls no longer disable template diagnostics (ng-mx-tags-call-ts991010)

Discovered Angular tag templates are projected as the existing generated TypeScript component module, rather than rejected as unwired pages. The editor's Angular worker also serves their generated `.ts` siblings in memory, so a caller keeps its positioned template diagnostics instead of only a misleading `TS-991010` at `(1,1)`. Angular `.mx` pages remain pending; target dispatch tables, registry descriptors and dispatch goldens are unchanged. The worker reads tag files from disk, so unsaved tag changes still require saving and rechecking the caller for Angular template diagnostics.

### Added: target selection errors (target-select, decisions 129/132)

`mx.target` selects its host behaviour. Policy errors surface as TS80003
errors plus TS80001 pointers at the document's start, naming the package
position, while compilation keeps the selected or fallback target for later
diagnostics. All four file-kind plugins report them. Existing host warnings
remain warnings; fixing a manifest still requires recompilation or reload.
Explicit `data` reports the registry's decision 131 addendum restriction.

### Fixed: the build no longer deletes worker declarations with a bare `rm -f` (plugin-ngdiag-dts-hygiene)

The build emitted and then `rm -f`'d `dist/ng-diagnostics.d.ts` and `dist/ng-worker.d.ts`; had a public type ever referenced `NgDiagnosticsService`, the tarball would have shipped a dangling import, caught first by pack-probe. `tsconfig.build.json` now excludes `src/ng-worker.ts` from the declaration emit, and `build/strip-ng-declarations.ts` removes the still-emitted `ng-diagnostics.d.ts` (the entry imports the module, so tsc always emits it). The strip fails the build before deleting anything when a shipped declaration references either module: it parses every module reference (`import`/`export … from`, bare `import`, `import()`/`require()`, `/// <reference path>`) and resolves each relative form — this package's declaration emit retains `.ts` specifiers, and `.js`, extensionless and `../` forms resolve to the same file. `src/strip-ng-declarations.test.ts` pins the guard with a real tsc-emitted `.ts` re-export (the case a filename suffix check missed) plus negative controls. `scripts/pack-hygiene.test.ts` pins the exact `dist/` contents, so a stripped declaration cannot creep back into the tarball. `@angular/compiler-cli` is now declared an optional peer (`>=22.0.0 <23.0.0`, the same declaration `@mxlang/angular-checker` carries): the worker resolves it at run time from the user's project, and the peer records that without forcing an install. No runtime or emitted-code change.

### Added: native event handlers are type-checked on preact, react and hono (jsx-handler-typing, decision 140)

The virtual code for these three hosts is now compiled with the hosts' `typeCheck` option, so a native element's event handler is checked against the host's own handler type and diagnostics land on the authored handler. Before, a mistyped handler was silently dropped (TypeScript reported it on the unmapped attribute name) and a valid `onKeyDown=((e) => e.key)` reported an implicit-any error. New errors on existing code are the ones plain TSX reports, including DOM-typed `(e: MouseEvent)` handlers on react. Runtime output (build, Vite, oracles) is unchanged; only the virtual code carries the wrapper.

### Changed: host policy and dispatch read the built-in lookup (refactor/target-open-set, decisions 129 and 132)

The plugin resolves each file's policy through `@mxlang/target-registry` and scans with the built-in lookup, matching `mx.tags[].hosts` on `hostFilterKey(policy.target)` (unchanged for every built-in). Each compile carries the lookup, so a callee importing `AttrTag` from another registered target's package is recognised as before. The dependency rule for `.solid.mx`/`.ng.mx` callees now reads the same lookup rather than a closed list in core. `isTranslateError` replaces `instanceof TranslateError`. No change to generated text, mappings or diagnostics; the dispatch goldens are unchanged.

### Fixed: `TS80001` drops Babel's 0-based `(L:C)` in every surface (ts-plugin-ts80001-babel-suffix)

The language plugin's compile-diagnostic producer now removes the trailing ` (line:column)` Babel appends to a syntax error, so tsserver, the language server and `mx-tsc` print the same text. Since the missing-close-tag opener position, an editor showed two bases in one sentence (`… opening "span" tag at 1:23 (1:32)`); it now reads `… opening "span" tag at 1:23`. Only a trailing, anchored `(digits:digits)` goes (SGR codes tolerated), and only when it equals the parser error's own `loc` (Babel line, 0-based column); a wrapped custom-tag error, a `TranslateError` or a plain `Error` keeps its text, since its `(L:C)` may be the only copy of a foreign source's position.

### Fixed: `TS80001` no longer repeats the file and position in its message (translate-error-no-repeated-path, audit item 17)

A parse error's message used to open with Marko's `    at <path>:L:C` line, which `mx-tsc` printed right after `file(L,C)` and an editor showed beside the range. The line is dropped when it names the diagnosed file; one naming another file (an error inside a callee tag) stays, since it is the only place that file is named. The code frame is unchanged.

### Changed: `.amx` is now `.astro.mx` (amx-to-astro-mx, decision 134)

The AstroMX language plugin claims `.astro.mx` instead of `.amx`, with no alias, and the `.mx` plugin declines `x.astro.mx` as it declines `.solid.mx` and `.ng.mx`. The diagnostic `source` string for these files is `astromx` (it was `amx`). `createAmxLanguagePlugin` and the module name keep `amx`.

### Added: host-policy diagnostics (host-policy-diagnostics-tsc-tsserver)

An unknown `mx.host` or a malformed `package.json` was silent in tsserver (the file just got the fallback host). Every language plugin now records what `resolveTargetPolicyDetailed` said for each file it compiles, per plugin instance (`getTargetPolicyDiagnostics(fileName?)`), and tsserver reports it as a `TS80003` warning on that file at 1:1, naming `package.json:line:col` (tsserver reports no diagnostics on a `package.json`). `mx-tsc` prints the same records positioned in the `package.json`. New exports: `HOST_POLICY_DIAGNOSTIC_CODE`, `hostPolicyMessage`, type `TargetPolicyDiagnostic`. The text is the language server's (`<package.json>:line:col: <message>`, the path said once; `hostPolicyText` is the message without core's leading path), and `source` follows the file kind (`mx`, `solidmx`, `ngmx`, `amx`). Known limit: the plugin does not watch `package.json`, so a fixed manifest clears the warning only once the `.mx` is edited or the project reloads.

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
