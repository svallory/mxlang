# typescript-plugin — agent instructions

## Current target dispatch (decisions 129/132)

Page compilation selects `lookupFor(policy).target(policy.target)` (a descriptor loaded from a package specifier included) and calls
`load(core).compileModule` with the full lookup and `typeCheck: true` (decision
140). Strictness, type surface, pending text, declarations and mapping mode
come from the descriptor. A merge-recorded target may omit both map and
mappings; those contribute no mappings. The second lowering still uses the
default target's translator (D3), regardless of the selected target, except
for a loaded descriptor with no `declarations`: it has no lowering policy of its
own, so the plugin maps from what it recorded and never re-lowers under html.

File recognition, diagnostic labels and region compilation use
`builtinFileKinds` and its pipeline. Discovery for fixed file kinds uses the
owning target's host filter, including Astro's D6 filter. Angular/Astro template
compilation and compiler services remain built-in tool glue, not page compilers.
The compatibility `createAstroTypeSurface` export forwards to the descriptor.
The Angular tag projection (`createVirtualTagModuleReader`, PR #264) runs
before page dispatch when the selected target owns a `ng-template` pipeline.
It never compares host names, and ordinary pages keep the pending diagnostic.
Data selection remains staged out by the registry's policy wrapper.

Both published dist and VSIX inline the registry, descriptors and host glue;
dist keeps core/parser external, while VSIX inlines them too. The source
imports Angular/Astro glue directly, so both packages remain declared workspace
dependencies even though their runtime code is bundled. Public types use the
declared Angular package and core's generic mapping type, never the private
registry. `file-kinds.ts` is excluded from declaration roots and stripped with
a dangling-reference guard (tsc still follows imports despite `exclude`).
`dist-dispatch.test.ts` and pack-probe's consumer Node smoke pin lazy loads;
check-vsix pins the shipped closure. The test project externalizes core/dist:
a native lazy require and a Vite-transformed second core otherwise split the
unsaved-buffer overrides (`core-identity.test.ts` pins that boundary).

Historical implementation details below predate this table dispatch.

## Exact-pin policy detail (typescript peer)

**A published package's `peerDependencies` is the one exception to the root exact-pin policy, and `typescript` is the case.** `@mxlang/tsc` and `@mxlang/typescript-plugin` declare `peerDependencies.typescript: ">=5.9.0 <7"`, because a peer is resolved from the *consumer's* project and an exact peer makes the package uninstallable for anyone on a different patch. The exact-pin policy still holds for every `devDependencies`/`dependencies` entry, including those packages' own exact `devDependencies.typescript` — the range is what a consumer may satisfy, the pin is what CI and local builds actually run (`typescript@6.0.3` today, bumped from `5.9.3`).

TypeScript must resolve to **one** copy: the TS plugin is handed the `ts` object by tsserver, and `mx-tsc` passes `require('typescript')` to Volar's `runTsc`, so a nested second copy breaks `instanceof` across that boundary and silently mistypes every file. `packages/tooling/tsc/src/peer-typescript.test.ts` asserts the property rather than the manifest text — every package declaring the peer resolves the same file on disk, and it is the workspace's own copy. Note the `examples/*` apps pin `typescript` themselves and are deliberately not covered.

**`@mxlang/language-server` declares no `typescript` peer**, deliberately. It has no reference to `typescript` anywhere in its source: TypeScript is only its *build tool*, running `tsc --emitDeclarationOnly` to produce `dist/*.d.ts`. It therefore keeps an exact `devDependencies.typescript` and nothing else — a peer would force every consumer to resolve a module the package never loads. The same test pins this, so the distinction cannot rot into a copy-paste peer.

**A package that emits declarations sets `rootDir` explicitly in its `tsconfig.build.json`.** TS 6 stopped inferring a common source directory when a build config and the `tsconfig.json` it extends disagree about one (`TS5011`) — which they do whenever `include` covers `test` and the build config excludes it, as `packages/hosts/angular` does. It belongs in the *build* config: putting `rootDir: "src"` in the base `tsconfig.json` instead makes the ordinary typecheck fail with `TS6059` for every file under `test/`.

**`@mxlang/typescript-plugin` ships `dist/index.d.ts`; `@mxlang/tsc` typechecks against the plugin's `src`** (ts-plugin-declarations). `tsc` imports the plugin as a TS module (`createMxLanguagePlugin`, …), so the packed `types` must be real declarations, not `src/index.ts`. The build is `bun build` (CJS) then `tsc -p tsconfig.build.json --emitDeclarationOnly`; `tsconfig.build.json` sets `types: ["node"]` because excluding the tests drops the `vitest` import that pulled `@types/node` in for the plain typecheck. `packages/tooling/tsc/tsconfig.json` maps `@mxlang/typescript-plugin` to `../typescript-plugin/src/index.ts` (`paths`) with `rootDir: "../.."` (TS6059 otherwise; tsc's bundle is built by `bun build`, so `rootDir` only matters to the typecheck). Why not the dist types: they made every typecheck path (root `typecheck`, moon, the per-edit hook) need a prebuilt plugin, failed with TS2307 on a fresh worktree, and gave false results on a stale dist (a new src export was TS2614, a removed one still passed). The published `types` stay on dist. The emitted declarations keep `.ts` relative specifiers (`allowImportingTsExtensions`), like the other packages; `pack-probe` reports the `node16` result and typechecks the packed tarball against them. Its Angular pipeline declarations import the declared `@mxlang/angular` dependency; Astro spans use core's generic mapping type. No published declaration may reference `@mxlang/target-registry`. The registry's pack-probe stub has no type surface, so it cannot hide a private-type leak.

**`dist/index.cjs`'s `module.exports` must be the plugin factory function, not an object.** tsserver loads a plugin with `sys.require` (a plain `require()`), does not unwrap `.default`, and skips the plugin with "did not expose a proper factory function" unless `typeof module === "function"`. `bun build --format cjs` emits the namespace object, so the build runs `build/cjs-factory.ts` after it, appending `module.exports = Object.assign(module.exports.default, module.exports)` (guarded by `typeof module.exports.default === "function"`, because vite-node's shimmed `module`, used by `@mxlang/tsc`'s tests, hands the bundle a non-function `.default`, where the bare assign throws): the factory carries `default` (itself) and every named export, so nothing is removed. Do not drop that step or "simplify" the export back to an object; `src/cjs-factory.test.ts` and `src/tsserver-load.test.ts` (a real tsserver) fail if it regresses. The ESM entry (`src/index.ts`, `export default pluginFactory` plus named exports) and `dist/index.d.ts` keep their shape.

**The plugin also has a VSIX-only self-contained build, `bun run build:bundled`** (`build/bundled.ts`, output `bundle/`, gitignored and outside `files`). It inlines `@mxlang/*`, volar and babel, applies `build/cjs-factory.ts` to `index.cjs` (`applyCjsFactory(entry)`), and builds the entries `index` and `ng-worker`. `build/bundled-config.ts` is the one list of entries and externals (`@marko/compiler`, `@astrojs/compiler`, `typescript`, `@angular/compiler-cli`, `@astrojs/language-server`), read by `packages/editors/vscode/scripts/*` too. The VS Code extension's `bun run package` copies `bundle/` into the VSIX; the npm tarball keeps `files` unchanged but also bundles the registry/descriptors and host glue in `dist/`. It is not the answer to `publish-plan-private-deps`.

## `@mxlang/typescript-plugin` and `@mxlang/tsc`: TypeScript for MX files (decision 81)

`packages/tooling/typescript-plugin` and `packages/tooling/tsc` are the two
halves of one job: type-check `.solid.mx` and `.mx` from the TS/TSX
each host emits.
Each package's own `README.md` carries the full story; this is the package-map
entry.

- **`@mxlang/typescript-plugin`** is the editor half — a Volar
  `LanguagePlugin` (`src/language.ts`) plus a tsserver plugin
  (`src/index.ts`, loaded via `compilerOptions.plugins`).
  `createVirtualCode` runs `@mxlang/parser`'s `print()` and wraps the printed
  TSX in a `VirtualCode` whose `CodeMapping`s are decoded from the returned
  map. A `print` failure yields empty virtual code plus one recorded syntax
  error, appended to `getSyntacticDiagnostics` so a bad region reports once,
  at its own position, instead of silently becoming an empty file.
  `src/mx-language.ts` compiles whole-file `.mx` through the host
  `@mxlang/core`'s `resolveTargetPolicy` picks from the nearest `package.json`
  (one resolver, shared with the language server, so an editor and a `tsc` run
  cannot disagree about a file's host); because the HTML compiler's map is
  empty, mappings come from the positioned IR nodes the emitter consumed — see
  the mapping-coverage bullet below for what is mapped per expression and what
  whole-block. `{ astro: true }` lazily composes Astro's language plugin
  from the optional exact `@astrojs/language-server@2.16.16` peer.
- **`@mxlang/tsc`** is the CI half — `mx-tsc`, Volar's `runTsc` handed the
  *same* language plugin. It exists because `tsc` ignores
  `compilerOptions.plugins` entirely, so without it an editor would report
  errors a build silently missed. `--astro` adds Astro's plugin and extension,
  and is removed before TypeScript parses its own arguments.

- **`.ng.mx` is its own file kind.** `createNgMxLanguagePlugin` (`src/language.ts`,
  language id `ngmx`) compiles it with `compileNgMx` from `@mxlang/angular`
  (no `print` round trip) and is routed by core's `hostModuleSegment(...) ===
  "ng"` *before* the host-policy branch; `isMx` excludes it. Outside the
  `template:` regions the module maps through `result.map`; each template
  expression maps through `result.mappings` (whole-to-whole, so the sides may
  differ in length: `generatedLengths` is set). TypeScript sees a region as an
  opaque template literal, so this yields class/module semantics only —
  template expressions need Angular's compiler. `tagSelectorPrefix` comes from
  `readAngularConfig`, which throws on a bad config: the plugin reports that as
  an error diagnostic at offset 0 and emits empty virtual code, never defaults.
  The host-policy "angular not wired" guard still covers Angular `.mx` pages.
  Discovered Angular tag templates bypass page dispatch and project the existing
  `compileTagModule` component as TS (not TSX). `createVirtualTagModuleReader`
  in the Angular host shares discovery and compilation with the checker's
  in-memory `.ts` sibling reader, so a tag call no longer aborts the caller's
  Angular template check with `TS-991010`. The TypeScript projection reads
  unsaved tag buffers; the forked Angular checker reads disk, so template
  diagnostics against a changed tag require saving it and rechecking the caller.
  `retainCompiled` (off by default) keeps each file's latest successful compile
  for `getCompiledNgMx()`: `mx-tsc` uses it to run Angular template diagnostics
  over the compiles its type-check used; an editor must not hold them all.
  **Editor Angular template diagnostics (`src/ng-diagnostics.ts`).** The
  `onCompiled` option of `createNgMxLanguagePlugin` hands each successful
  compile to an `NgDiagnosticsService` (one per tsserver project, created in
  `create()`), which schedules a check per `mx.angular.diagnostics` (`idle`:
  1 s after the last compile, `save`: a `serverHost.watchFile` write, `off`:
  nothing, not even a worker) and keeps the answer only while the file's text
  equals the text it was computed for. The check runs in a **forked worker
  process** (`@mxlang/angular-checker`'s `createCheckerWorker`; one per nearest
  `package.json`; superseded runs are never delivered, and a stale run still
  going after 5 s is SIGKILLed and restarted; the worker ends when tsserver's
  IPC channel closes). `@mxlang/angular-checker` is a **devDependency**: the bundle inlines it (no bare import of it in `dist/*.cjs`). No packed declaration reaches the checker or `@angular/compiler-cli`: `tsconfig.build.json` excludes `src/ng-worker.ts` from the declaration emit, and `build/strip-ng-declarations.ts` removes the still-emitted `dist/ng-diagnostics.d.ts` (the entry imports the module, so tsc always emits it) — failing the build before deleting anything when a shipped d.ts references a stripped module: it parses every module reference (`import`/`export … from`, bare `import`, `import()`/`require()`, `/// <reference path>`) and resolves each relative form (this repo's emit retains `.ts` specifiers; `.js`, extensionless and `../` resolve to the same file). `src/strip-ng-declarations.test.ts` pins the guard with a real tsc-emitted `.ts` re-export plus negative controls (pack-probe's `skipLibCheck:false` node16 typecheck failed with TS2307 otherwise, and `scripts/pack-hygiene.test.ts` pins the exact dist contents). `angularDiagnostics` is not exported from the entry. The build emits `dist/ng-worker.cjs` beside
  `dist/index.cjs` (`src/ng-worker.ts`, resolved via `__dirname`) and keeps
  `@angular/compiler-cli` external: the worker resolves it from the user's
  project — it is an **optional peer** (`>=22.0.0 <23.0.0`, same declaration as
  `@mxlang/angular-checker`, with the exact devDependency for CI), never
  installed by the plugin itself. Delivery hook: the `getSemanticDiagnostics` branch of the same Proxy
  that injects compile diagnostics into `getSyntacticDiagnostics`
  (`index.ts`, `angularDiagnostics`); the async refresh is
  `Project.refreshDiagnostics()` (public in TS 6.0, emits
  `projectsUpdatedInBackground`, which makes the client re-run `geterr`). A
  missing compiler-cli / bad tsconfig and the compiler *option* diagnostics are
  per-project **notices**, computed once and shown on **every open** `.ng.mx`
  the editor asks about (no owner file; tsserver can only attach a diagnostic
  to the file it was asked about, so they are not attached to the tsconfig; the
  text names the tsconfig and, for compiler-cli, says to restart the TS server).
  Checks, idle timers and `save` watchers exist only for **open** files
  (`isOpen` = `project.getScriptInfo(f).isScriptOpen()`): the program compiles
  every closed `.ng.mx` too, and `getSemanticDiagnostics` calls
  `service.request(file)` to schedule a file compiled before it was opened and
  to release files that have since closed. The plugin never loads compiler-cli in the
  tsserver thread. the `index.test.ts` "real plugin wiring" tests drive the whole path
  (`pluginFactory.create`, the Proxy, refresh, `project.close`) with the real
  worker; `ng-editor-path.test.ts` is the language-plugin-level guard;
  `ng-worker-bundle.test.ts` checks the built bundle.
  **Known limitations (2.3b-2b):** a
  config error stays until the `.ng.mx` is next edited, and the plugin tracks no
  `dependencies` for `.ng.mx`, so an edit to `package.json` or to a called tag
  file takes effect when the `.ng.mx` is next edited or reopened.

- **`mx-tsc` also runs Angular template diagnostics** (`packages/tooling/tsc/src/ng-diagnostics.ts`).
  It creates the `.ng.mx` plugin with `retainCompiled`, and after `runTsc`
  hands the retained compiles to `@mxlang/angular-checker`'s `diagnoseNgMx`,
  one checker per project (nearest `package.json`), disposed at the end. The
  module is presented to the checker as `<file>.ng.mx.ts` so its imports and
  `@angular/core` resolve from the project. `mx.angular.diagnostics` `"off"`
  skips a project before `@angular/compiler-cli` is touched; so does a run with
  no `.ng.mx` files. With `.ng.mx` files and diagnostics on, a missing,
  out-of-range or unloadable compiler-cli, an invalid config, or a check that
  throws **fails the run** with an explicit message (a silent pass would leave
  templates unchecked in CI); template errors fail it too. **Under `-b` the
  pass runs for every project of the graph, up to date or not**
  (`packages/tooling/tsc/src/build-templates.ts`): an up-to-date project never
  gets a program, so its plugin never compiles its `.ng.mx`, and tsc's build
  info knows nothing about templates. `resolveBuildProjects` walks the named
  projects and their `references` (dependencies first, tsc's build order);
  `compileProjectNgMx` (in `index.ts`) runs the real patched `tsc` again per
  project as `-p <tsconfig> --listFilesOnly` (same plugins, resolver and
  options as non-build mode; tsc's own output swallowed) and takes the `.ng.mx`
  compiles that program made. The program is the source of truth: do not
  re-implement tsc's file selection or module resolution (a hand-written import
  walk missed `paths` aliases and crossed project references). A file is checked
  once, under the first project in build order whose program holds it.
  `--clean` skips the pass; `--dry` prints what it would check. Never gate this on tsc's up-to-date state. Fixtures under
  `packages/tooling/tsc/src/fixtures` find compiler-cli by walking up to
  `packages/tooling/tsc/node_modules`, so tests for a *missing* or
  *out-of-range* compiler-cli build their project under the OS temp dir. The
  stub-`Component` fixtures (`ng-mx-passing`/`failing`) set diagnostics `"off"`
  because they test TypeScript semantics; `ng-diag-*` use real `@angular/core`.

`packages/tooling/tsc/package.json` pins `"mx": { "host": "html" }` on purpose:
  it now depends on `@mxlang/angular`, and the many fixtures without their own
  `package.json` resolve their host from the nearest one above them, where a
  single host dependency would otherwise make every one of them an angular
  project (`the angular host is not wired ...`).

Four facts worth knowing before editing either:

  **Extended diagnostics (NG8103).** `mx-tsc` never sets a category: the
  checker is built from the project's tsconfig (`readConfiguration`), and
  ngtsc applies `angularCompilerOptions.extendedDiagnostics` (`checks` and
  `defaultCategory`; check name `missingControlFlowDirective` for NG8103) itself,
  so a promoted check should arrive as `category: "error"` and fail the run, a
  suppressed one should never arrive (verified end to end in `mx-tsc` by the
  test below; **not tested** through the editor plugin's `NgDiagnosticsService`,
  which maps categories to error|warning only). Do not re-map categories in
  `tsc/src/ng-diagnostics.ts`. Pinned by `tsc/src/ng-extended-diagnostics.test.ts`
  (fixture `ng-diag-ngif`, one tsconfig per case).
- **`runTsc` needs `require('typescript')` passed as its fourth argument.**
  Its default `typescriptObject` is a proxy resolving names by `eval` inside
  `tsc.js`'s own scope, so it sees only that bundle's locals. `ScriptSnapshot`
  is not one — it is on the public `typescript` module but not the `tsc` entry
  point — and the language plugin dies with `ReferenceError: ScriptSnapshot is
  not defined` before a single file is checked.
- **`createCompoundExtensionResolver` is load-bearing and shared.** Volar
  2.4.28 assumes a custom extension is one suffix, so for `X.solid.mx`
  TypeScript probes `X.solid.d.mx.ts`. The resolver claims no file
  (`getLanguageId` and `getServiceScript` both return undefined) and only
  advertises the terminal `mx` suffix; without it every `import
  "./X.solid.mx"` is `TS2307`. It lives in `language.ts` and is installed by
  both entry points, so an editor and CI resolve imports identically.
- **`mx-tsc` must be CJS.** `runTsc` uses `require`, `require.resolve` and
  `__filename`, none of which exist in an ES module — hence `dist/bin.cjs`.
- **Column accuracy comes from the parser bridge, not from this package.**
  `print`'s map is line-based; the exact columns come from
  `packages/parser/src/mx/bridge.ts` repositioning each Babel node onto the
  source expression it was copied from. `decodeMappings` then keeps only spans
  whose generated and source text match, and merges contiguous ones.
  Whole-file `.mx` is the exception: its HTML map is empty, so the
  plugin maps from the core IR node locations — per expression for every
  `Expr`, and **whole-block** for the five statement kinds (`Static`,
  `Import`, `Export`, `InputInterface`, `Hoisted`), which carry an `end`
  position beside `loc` for exactly this reason. A mapping is emitted only
  when the code is found in both texts, the generated search running forward
  and keyed per code string so repeated text cannot cross-map; when either
  lookup fails nothing is emitted, since a plausible-but-wrong column is worse
  than none. A diagnostic outside every mapping is reported on the nearest
  enclosing tag or attribute (else 1:1) with a position marker appended, never
  dropped (decision 161; see the section below).
- **`preventLeadingOffset` must stay unset for both whole-file `.mx` and
  `.solid.mx`.** With that flag set, Volar's `runTsc` parses its
  `SourceFile` from the generated text alone, so `tsc` converts a correctly
  mapped source *offset* into line and column against the *generated*
  file's line table instead of the source's — wrong whenever the two line
  tables disagree. Unset, Volar pads the virtual contents with the source's
  own lines (each line replaced by matching-length spaces, in
  `proxyCreateProgram.js`) so the offset lands on the same line/column in
  both. Whole-file `.mx` needed this from the start, because its compiled
  module drops the source's line structure entirely (measured: a two-error
  fixture reported (3,15)/(4,22) for errors on source lines 2 and 3).
  `.solid.mx` used to keep the flag set, reasoning that its printed output
  preserves the region's line *count* — true, but irrelevant: a line the
  printer reformats (e.g. an `Input` interface losing whitespace) still
  shifts every later column while the line number stays put, which is
  `preventLeadingOffset`'s exact failure mode
  (`solid-mx-tsc-column-against-printed-text`; measured: `export const
  broken` on line 4 reported column 17 against an authored column of 14).

**`.solid.mx`'s virtual TSX gets a synthetic, unmapped import for the Solid
JSX built-ins the emitter prints as a bare tag** (`Show`/`For`/`Switch`/
`Match`/`Repeat`/`Errored`/`Loading` from `solid-js`, `Dynamic` from
`@solidjs/web`) — `@mxlang/solid`'s `appendSolidBuiltinImport`, which is the
`.solid.mx` file kind's `completeTypecheckModule` (decision 154): the region
plugin (`createRegionLanguagePlugin`, one per region file kind) calls the
kind's hook, never a Solid function by name. `@mxlang/solid`'s own emitter never imports
these (see `packages/hosts/solid/AGENTS.md`): the real build pipeline gets
them from `@solidjs/vite-plugin`'s compiler stage auto-importing every
built-in it sees, a stage that runs *after* `createVirtualCode` and never
inside this package, so without this the projection saw a free identifier
and reported TS2304 on every `<if>`/`<for>`/`<try>` — hiding every real
diagnostic inside that JSX (solid-virtual-code-hidden-errors). The import is
appended after every mapping is computed from the unmodified generated text
(source-map offsets, `attributeTagDiagnosticMappings`), so it cannot shift
an existing line or offset; it is skipped for a name already bound by an
`import`/`const`/`function`/`class` at the top level of the generated file,
so an author's own same-named export is never shadowed. Shadow detection
(`sourceBindings`) parses the generated text with `@mxlang/parser`'s
`parseBabel` and reads each top-level declaration's actual bound name — an
import's *local* name (so `import { Show as MyShow }` binds `MyShow`, never
`Show`), and destructured `const`/`function`/`class` names — rather than
scanning lines for the built-in's name as text: a line-based probe cannot
tell a multi-line `import {\n  Show,\n} from "solid-js"` from an unrelated
line, and cannot tell a bound identifier from a substring inside an alias
clause. **A type-only import never counts as a binding.** Both
`import type { Show } from "x"` (the whole declaration's `importKind`) and
`import { type Show, For } from "x"` (one specifier's own `importKind`) are
excluded, since neither introduces a value named `Show` the emitted `<Show>`
tag could actually resolve to — only `declare const`/`function`/`class` and
an ordinary value import do that.

**No ambient `declare module "*.solid.mx"` shim, anywhere.** A shim asserts
types rather than deriving them, so it hides both a file's real exports and
every error inside it. Both examples' `src/mx.d.ts` are deleted; dropping
`todomvc`'s surfaced a real bug it had been masking (a `<fragment>` wrapper,
removed by decision 72, rendering as a literal unknown element).

`packages/tooling/tsc/src/fixtures/` holds two Solid projects differing in
one expression. The suite also runs the Astro example's paired
`typecheck-fixtures`: `<Card title="..." />` passes and `<Card title={1} />`
reports TS2322. The failing fixtures stay outside their packages' normal
typecheck inputs.

## Attribute-tag call sites and callee dependencies (phase 4a)

A caller's attribute-tag value is emitted with `satisfies
NonNullable<Parameters<typeof Callee>[0]["tag"]>`, so TypeScript checks it
against the callee's declared `AttrTag` type. The emitted *shape* comes from
core reading the callee's `Input`; the *types* come from TypeScript resolving
the callee module.

**A test that reports through Volar cannot prove what the emitted
TypeScript checks.** Before decision 161 Volar dropped a diagnostic whose
position has no mapping, and most of an attribute-tag value is generated code;
such a diagnostic is now reported at its enclosing tag or attribute, which says little
about *what* was wrong, so assert on the emitted text for anything about types. The Solid and Preact
emitters once applied `satisfies` to the wrong expression (`() => x
satisfies T`), every valid caller's virtual code carried a TS1360, and
`mx-tsc` and the plugin service both stayed clean. `emittedDiagnostics`
(`src/index.test.ts`) type-checks the emitted text itself and returns every
diagnostic; use it for anything about the generated code's types.

- **Never register a callee through `CodegenContext.getAssociatedScript`.**
  A Volar associated script is a file whose content is embedded in its
  target's virtual code, and `@volar/typescript`'s `getServiceScript`
  (`lib/node/utils.js`) answers for any script with `targetIds` using the
  *target's* service script. A callee is a program file with virtual code of
  its own, so associating it maps the callee's diagnostics through the
  caller's mappings and reports them in the caller's file. Measured on
  `examples/todomvc`: `TodoItem.solid.mx` and `Footer.solid.mx` diagnostics
  sitting in unmapped generated code (normally dropped) surfaced as seven
  errors in `App.solid.mx` at unrelated lines, and `mx-tsc` exited 2. The
  same routing is used by every proxied tsserver method, so an editor was
  affected too. Regression tests: `reports a %s callee's own type error
  against the callee` (`src/index.test.ts`) and the `callee-diagnostic-*`
  fixtures in `packages/tooling/tsc`.
- **`compileWithDependencies` reads dependency text through `readSource`**
  (`DependencyLanguagePluginOptions`, `src/language.ts`). The tsserver plugin
  passes a reader over `info.project.getScriptInfo(...)`, which returns an
  open callee's unsaved buffer; `mx-tsc` passes none and compiles once,
  because a one-shot run has only the files on disk and core reads those
  itself. With a reader, each pass uses the accumulated sources every
  previous pass has read, and a changed dependency set triggers another pass
  unless the host holds nothing new for it — iterating to a fixed point
  rather than stopping after one retry, capped at `MAX_COMPILE_PASSES` (8) so
  a dependency cycle or a pathological chain still terminates (fix for
  `compile-with-dependencies-nesting-limit`, filed from PR #149). **A real
  chain reaches this**: a callee's `AttrTag<Alias>` — the whole type
  argument, not a nested field reference like `AttrTag<{ attrs: Alias }>` —
  can itself alias a type `import type`-ed from a further file, which
  `readCalleeInput`'s own `resolveNamedType`
  (`packages/core/src/callee-input.ts`) follows across files up to
  `MAX_ALIAS_DEPTH` (4), independently of this loop's own pass count. Before
  the fix, a chain three hops deep (caller → callee → alias file → a further
  aliased file) could have its deepest hop discovered only by the single
  retry's own compile, with no further pass to read it fresh — pinned by
  `compileWithDependencies against a real readCalleeInput compile` in
  `src/index.test.ts`, driven through the real `readCalleeInput`, not a
  synthetic callback. **The nested-field-reference shape
  (`AttrTag<{ attrs: Alias }>`) is not subject to this at all**: measured by
  instrumenting `compileWithDependencies` directly, a type referenced only
  that way never enters `ctx.dependencies` in the first place — it is
  resolved entirely through the emitted `satisfies
  NonNullable<Parameters<typeof Callee>[0]["tag"]>` reference, which
  TypeScript's own live module graph re-checks on every edit regardless of
  this function (decision 107, option A, next bullet).
  **Reaching the cap without settling is not silent (compile-deps-cap-warning,
  fix-forward for PR #150).** When the loop falls through all
  `MAX_COMPILE_PASSES` passes still finding a new dependency set or new
  source text each time, `compileWithDependencies` pushes an `MxWarning` onto
  `result.warnings` (when the generic result type carries one) naming every
  dependency discovered across the unsettled chain, positioned at the file's
  own start (line 1, column 1) — there is no single call site that owns an
  unsettled chain spanning the whole compile. Every caller
  (`mx-language.ts`, `amx-language.ts`, and this file's own
  `createSolidMxLanguagePlugin`) already destructures `warnings`
  unconditionally from the result and maps it through `warningDiagnostic`
  into `compileDiagnostics`, so the warning reaches `getCompileDiagnostics`
  with no caller-side change.
  **The cap's own final (8th) compile must be checked for settling too,
  not just passes 1–7 (round-2 fix, same TODO).** The loop's fixed-point
  check (`sameDependencies`/`sameSources`) runs at the *top* of each
  iteration, against the *previous* pass's result — so it validates compiles
  #1 through #7 but never the compile produced *inside* the 7th iteration
  (the one that runs right before the loop condition fails at `pass ===
  MAX_COMPILE_PASSES`). A chain that discovers a new dependency every pass
  through pass 7 and then genuinely settles on pass 8 used to still get a
  false-positive warning, because nothing re-ran the settle check against
  that last result before falling through to the push. Fixed by repeating
  the same `sameDependencies`/`sameSources` check once more after the loop,
  against the final `result` — pinned by `produces no warning when the chain
  genuinely settles on its 8th (final) compile` in `src/index.test.ts`.
  **Measured: a real attribute-tag alias chain cannot organically drive this
  loop to the cap.** `readCalleeInput`'s own `resolveNamedType` bounds
  alias-following to `MAX_ALIAS_DEPTH` (4) within a single compile,
  independent of this loop's pass count — a chain of 5+ aliased hops fails
  `attrTagConfig`'s "declare this attribute tag's config literally" check on
  the very first pass that needs the 5th hop, before `compileWithDependencies`
  ever gets a chance to retry. The cap therefore exists for a dependency set
  that keeps changing for reasons other than alias depth (a pathological
  chain elsewhere, or a future dependency producer); the unit tests in
  `src/index.test.ts`'s `compileWithDependencies` describe block cover the
  cap with a synthetic `compile` callback for this reason, not a real
  `readCalleeInput`-driven chain. **The real-caller plumbing is still proven
  end to end**, in `src/compile-deps-cap-warning.test.ts` (a dedicated file
  so its `vi.mock("@mxlang/preact", …)` cannot leak into any other suite):
  it mocks only `compilePreactMx` — the one host compile function
  `mx-language.ts` calls for the "preact" host policy — to report one more
  dependency every pass, and drives everything else for real
  (`createMxLanguagePlugin`, the genuine `compileWithDependencies` loop, and
  `getCompileDiagnostics`), asserting the cap warning lands as a single
  diagnostic with the chain text at the caller's own file.
- **What follows a callee change in tsserver (decision 107, option A).** A
  change to the callee's *types* re-checks the caller at once, through
  TypeScript's own module graph (tests: `a callee's Input changing under an
  unchanged caller`). What the caller *compiled to* (the emitted shape and
  its stored compile warnings) is replaced only when the caller itself is
  compiled again; Volar gives a language plugin no way to invalidate another
  file's virtual code. The language server re-diagnoses every open dependent
  and covers that case. Documented for authors in
  `apps/docs/docs/language/attr-tag.md`.
- **The mapping pass does not report warnings.** `createHtmlMappings` lowers
  the source a second time; handing it the compile's own `warnings` array
  reported every warning twice.
- **Fixed: `solid-attr-tag-attr-offset`.** On the Solid host, a wrong
  attribute type inside `<@tab title=1/>` used to be reported on the tag
  name (`tab`), not on `title`; a missing attribute is still reported on
  the tag name by design (there is no attribute text to point at).
  `decodeMappings`'s text-equality walk can map an attribute's *value*
  exactly (it is copied verbatim into the generated object literal, e.g.
  `title=1`'s `1`), but never its *key*: the printer re-quotes it (`title`
  becomes `"title"`), so no generated/source text ever matches. TypeScript
  can position a property type-mismatch diagnostic anywhere from the quoted
  key through the value, and a *range* diagnostic only resolves through
  Volar's `toSourceRange` when the same mapping covers both ends
  (`findMatchingStartEnd` translates the range's end through whichever
  mapping matched its start) — so `attributeTagDiagnosticMappings` now adds
  one supplemental mapping per attribute, spanning its whole `"key": value`
  generated text back to its authored `key=value` source span, with the
  surrounding whole-object fallback mapping punched to exclude that range.
  The punch is required, not cosmetic: `@volar/source-map`'s lookup yields
  every mapping containing a generated offset in *array* order, so an
  overlapping wider span, if it sorted first, always won over a narrower
  one sorted after it by `createVirtualCode`'s ascending
  `generatedOffsets[0]` sort — two mappings must never share a generated
  offset, or the wider one silently wins regardless of which is "more
  specific". html and preact apply `MappedCode` offsets directly and were
  never affected.
- **Fixed: `custom-tags-template-error-positions`.** A `TranslateError`
  raised while compiling a tag template (`tags/x.mx`) was always reported
  against the *caller's* file and text at the call's own offset — the three
  `toSyntaxError` functions (`mx-language.ts`, `amx-language.ts`,
  `language.ts`) read only `error.line`/`error.column` and ignored
  `error.file`, the field `template-tag.ts` stamps with the template's path
  when a unit's metadata compile fails (spec §2's third position rule; see
  `packages/core/AGENTS.md`). `foreignTemplateError` (`language.ts`) now
  detects a `TranslateError` whose `file` names another file, reads that
  file's current text (the supplied `readSource`, else disk — the same
  fallback order `readCalleeInput` uses), and returns two diagnostics: the
  real one, keyed under the template's own filename in the plugin's
  `compileDiagnostics` map, and a pointer diagnostic on the caller naming the
  template — matching `diagnoseDocument`'s `related`/pointer split exactly.
  All three `createVirtualCode` catch blocks call it before falling back to
  their own `toSyntaxError`. `mx-tsc` needed no separate wiring: it already
  aggregates every language plugin's `getCompileDiagnostics()` with no
  filename filter, so a diagnostic keyed under the template's path is
  reported under that path automatically. The same shape (a `TranslateError`
  carrying `.file`) is separately handled in `@mxlang/vite-plugin`'s
  `transform` catch and `@mxlang/astro`'s `AstroTemplateError`/
  `vite-templates.ts` (that package's own `AGENTS.md`), for the dev-server
  and build path rather than the editor.
  **Known limitation: tsserver's pull model, not this package's diagnostic
  routing.** `templateDiagnostic` is only ever *returned* from
  `getCompileDiagnostics(templateFileName)` — it is up to tsserver to call
  that with the template's own filename, which in practice only happens for
  a file the editor has open (or explicitly queries), because
  `getSyntacticDiagnostics` (`index.ts`'s `withSyntaxDiagnostics`) is a pull,
  not a push. The language server does not have this gap: it *pushes*
  diagnostics for the template's own URI unconditionally over LSP
  (`connection.sendDiagnostics`, `packages/tooling/language-server/src/server.ts`),
  regardless of whether that document is open. So in an editor using only
  this plugin (no language server alongside it), a broken template that is
  not itself open in a tab shows nothing directly on the template — only the
  caller's pointer diagnostic, which is why that diagnostic's message names
  both the template's file *and* its exact `line:column` (`foreignTemplateError`
  in `language.ts`) rather than just the filename: it has to be enough to find
  the error without ever opening the template. There is no tsserver-side fix
  for the underlying gap; running `@mxlang/language-server` alongside this
  plugin (both are supported together, see that package's `AGENTS.md`)
  closes it.

## Ambient types a host adds (`TargetHost.ambientTypes`, `mx-tsc` and the editor)

A framework's own tooling adds declaration files to every program it checks that a project's `tsconfig.json` never lists. Astro's language server (`addAstroTypes`) adds `astro/env.d.ts` (which declares `Fragment`) and `astro/astro-jsx.d.ts`, or its own fallback copies without an astro install, by decorating a LanguageServiceHost. Neither Volar's `runTsc` nor this plugin's tsserver path did that, so `Fragment` was TS2304 under Astro's own tsconfig preset unless the project listed `types: ["astro/env"]`.

The fact lives in the host: `TargetHost.ambientTypes({ rootNames, resolve })` (core) returns the files for a program, or `[]` when the program holds none of the host's files. Astro answers for `.astro.mx` and plain `.astro` roots. `src/ambient-types.ts` is the one implementation both tools share:
- `ambientTypeFiles(rootNames, projectDir)` asks every host of the project's lookup (`lookupFor(resolveTargetPolicy(<projectDir>/package.json))`: the built-ins plus a third-party host the project loads). It resolves `<package>/<file>` from the project's `node_modules`, then from the plugin's install.
- `mx-tsc` appends the result to `rootNames` in its `runTsc` callback (`addAmbientTypes`, before the program is created).
- The tsserver plugin decorates `info.languageServiceHost.getScriptFileNames` (`withAmbientTypes`, inside the `createLanguageServicePlugin` callback, recomputed only when the root list changes). Its project directory is the configured project's tsconfig directory, else the project's current directory.

Nothing in tsc or this package names a host. Tests:
- `src/ambient-types.test.ts`, including a third-party fake host (`test-fixtures/third-party-targets/ambient-types`).
- `index.test.ts` "the hosts' ambient types in the editor": the real plugin with `{ astro: true }` and a plain `.astro` page.
- `packages/tooling/tsc/src/astro-ambient-types.test.ts`: real isolated installs, with and without astro, `.astro.mx` and plain `.astro` alone.
- `examples/astro-static`, which no longer lists `astro/env`.

## TS1108 in the `.astro.mx` fence (`mx-tsc --astro` and the editor)

A top-level `return` in the `---` fence is valid Astro, but `convertToTSX` puts the fence at module level, so TypeScript reports TS1108. `amx-language.ts` closes it twice: `filterSemanticDiagnostics` (tsserver proxy only) and, for every surface including `mx-tsc`, `withFenceVerification`, which gives the mappings lying wholly inside the fence a `CodeInformation` whose `verification.shouldReport` rejects code 1108. Volar's `transformDiagnostic` applies `shouldReport` inside `runTsc` too, and it is the only seam there: `mx-tsc` never holds the decorated program. A 1108 outside the fence (a hoisted `static` block), in `.mx`, or in a plain `.ts` is still reported. The host-dispatch goldens show that mapping's `verification` as `{}` (a function does not serialise). Tests: `packages/tooling/tsc/src/astro-fence-return.test.ts`.

## A diagnostic with no source mapping is never dropped (decision 161)

Volar's `transformDiagnostic` returns `undefined` for a diagnostic it cannot map to the source, and both `mx-tsc` (`decorateProgram`) and the tsserver proxy (`getSemanticDiagnostics` and its siblings) filter those out: a page whose errors sit in generated text no mapping covers type-checked clean (whole-file Solid values, an atom inside a region value, scaffolding). `src/unmapped-diagnostics.ts` runs **beneath** Volar, on TypeScript's raw diagnostics: for each one Volar cannot map it adds a mapping from the diagnostic's generated range to the nearest *enclosing* authored span (attribute, then tag, then the file start 1:1; never a preceding sibling) and appends ` (position approximate: generated L:C)` when the diagnostic is the author's, ` (position unknown in this file kind: generated L:C)` when it is the author's in a kind with no `authoredSpans` (it lands at 1:1), ` (in MX-generated code, not yours: an MX bug; generated L:C)` otherwise (per range, not per line), then Volar maps that normally. The author's means: its text is spelled by the author in the source it came from, or mapped authored code is inside or next to its range. The enclosing span comes from the virtual code's optional `authoredSpans()` (whole-file `.mx`: `src/authored-spans.ts`, read from the Marko parse: `tag`, `attribute` and `code` spans; region, `.astro.mx` and `.ng.mx` have none yet, TODO `unmapped-diagnostics-region-enclosing-spans`): the diagnostic came from the source between the nearest mapped range before and after it, narrowed to what the author spelled there — for an element diagnostic (`<p …>`/`</p>`) the tag of that name; for an identifier or literal a tag or attribute of that name, or a whole-token occurrence inside a `code` span (never static text or a quoted attribute string; without spans, the whole gap). Placement reads only the module's own mappings, and overlays are kept after them shortest first (Volar takes the first mapping holding both ends), so the result does not depend on diagnostic order. The added mapping is `verification`-only (no hover, completion or navigation) and reset into `@volar/source-map`'s memo through two private fields, which `unmapped-diagnostics.test.ts` and the end-to-end tests pin. Each `relatedInformation` entry and each `program.emit()` diagnostic goes through the same function. An exactly mapped diagnostic is returned as the same object.

- **Two attachments, one function.** The tsserver plugin wraps `info.languageService` inside the `createLanguageServicePlugin` callback (before Volar proxies it; the Volar `Language` arrives later through the callback's `setup`). `mx-tsc` replaces the `decorateProgram` export of `@volar/typescript/lib/node/decorateProgram` (`approximateUnmappedInVolar`, once per process) because `runTsc` never hands the program back. That relies on `proxyCreateProgram` reading the export at call time; it throws if the export cannot be replaced, so a Volar change cannot silently bring the drop back. The VSIX inlines Volar, but only the tsserver attachment ships there and it patches nothing.
- **A deliberate suppression is not a gap.** A range *any* mapping covers is left to Volar even when that mapping's `verification.shouldReport` rejects the code (`.astro.mx` fence TS1108): the host chose to hide it. Only a range no mapping covers is moved.
- **The language server is out of scope by design:** it publishes core compile diagnostics only, each with its own source position, and runs no type check.
- Tests: `src/unmapped-diagnostics.test.ts` (unit, with Volar's `transformDiagnostic` as the oracle for "not swallowed"), `index.test.ts` "decision 161" (tsserver plugin), `packages/tooling/tsc/src/unmapped-diagnostics.test.ts` (`mx-tsc`, fixture `unmapped-solid-failing`).

## Failed compiles produce a typed stub module, never `""`

When a template fails to compile, `createVirtualCode` returns `failedModuleStub(source)` (`src/failed-module-stub.ts`), not an empty string. An empty virtual module is not a module, so each importer gets `TS2306 … is not a module`, printed by `mx-tsc` *before* the real compile error and at the wrong file. Do not revert it to `""`.

The stub is `export default` of an `any`, plus `Input` and every `export`ed name found by a tolerant lexical scan of the failed source (the source did not parse, so a real parse is unavailable; the scan uses `[ \t]+`, never `\s+`, so a half-typed `export type` cannot swallow the next line, and drops reserved words), including destructured exports and `export {…}` lists; `export * [as N] from` lines are copied verbatim. Each name gets a type alias accepting up to 8 type arguments, and a value whose type depends on the declaration's kind: a `function`, `class` or `const`/`let`/`var` whose initializer is an arrow, function expression or class expression (through parentheses, `as`, `satisfies`, `!`; also when named in an `export {…}` list) is a callable, constructible, generic shape (`{ <_0=any…_7=any>(...a): any; new <…>(...a): any; [k: string]: any }`), so `make<number>()` and `new Box<string>()` do not give `TS2347`; every other name (data consts, enums, interfaces, types, `Input`) is plain `any`, so `const n: number = count`, `count + 1`, `count === 1`, `switch`, `for…of`, spread and index use type-check. No single type is both callable with type arguments and assignable to `number`, hence the split. Contextual keywords (`get`, `set`, `type`, `from`, `of`, `async`) and unicode identifiers are kept; only truly reserved words are dropped. The helper names are `__mx$failed$` and `__Mx$Any$` so an export cannot collide with them. Initializers are classified with the TypeScript AST (`ts.createSourceFile`, TSX, only the slice of that one statement, never the whole failed file; anything unparseable is `any`, the safe default), so a JSX value (`export const view = <Card/>`, the canonical `.solid.mx` export) or `(1 + 2)` stays `any`; never classify by regex on the first token. Cost: ~1 ms for a 20k-line file with 100 exports. Known limits: a name the scan cannot see (e.g. an export built by a macro) still reports `TS2305` at the importer; a callback passed to a method of a stubbed value (`list.map((x) => …)`) reports `TS7006` under `noImplicitAny`, which is inherent (an `any` receiver does the same). The stub has no source mappings, so a diagnostic inside it (there should be none) is reported at 1:1 marked as MX-generated code rather than dropped (decision 161). Tests: `describe("failed compile leaves a typed stub module")` in `src/index.test.ts` and the `compile-error-importer` fixture in `packages/tooling/tsc`.

## Host-policy diagnostics (`TS80003`)

`resolveTargetPolicyDetailed` (`@mxlang/core`) reports an unknown `mx.host` and a malformed `package.json` as positioned warnings. The language plugins (`.mx`, `.solid.mx`, `.ng.mx`, `.astro.mx`) each own a `TargetPolicyRecorder` (`host-policy-diagnostics.ts`): `createVirtualCode` resolves the file's policy through it and keeps the diagnostics per file, replacing them on every recompile of that file (see *Staleness* below). State is per plugin instance and never process-global: tsserver hosts several projects per process, each with its own plugins (team-lead ruling).

- **tsserver:** `getSyntacticDiagnostics` (`index.ts`) adds them to the `.mx` file as `TS80003` warnings at 1:1, because tsserver reports nothing on a `package.json`. The text is the language server's, `<package.json>:line:col: <message>` (`hostPolicyMessage`; core's own leading `<package.json> ` is dropped, so the path appears once). `source` follows the file kind like the compile diagnostics (`mx`, `solidmx`, `ngmx`, `amx`).
- **`mx-tsc`:** `reportTargetPolicyDiagnostics` prints them at the `package.json` position (the same text through `hostPolicyText`, no repeated path), deduplicated by file + message across programs.
- **Always warnings.** The exit code of `mx-tsc` is unchanged by them (nothing that built before may start failing). `.ng.mx`, `.solid.mx` and `.astro.mx` hosts are fixed by their extension; those plugins resolve the policy only to report.
- **Staleness (known limit).** The plugin does not watch `package.json`. After you fix it, the warning stays until the `.mx` file is edited (which recompiles it and re-resolves the policy) or the project reloads; the host choice itself is as stale. The language server does not have this limit (it records `package.json` as a dependency). Two tests pin it (`host-policy diagnostics through tsserver`: the same-service edit clears it; fixing `package.json` alone does not). A `package.json` watch is a follow-up; when it lands, flip the pinning test.

## Handler typing on the shared JSX hosts (decision 140)

`mx-language.ts`'s `compileMxVirtual` passes `typeCheck: true` to `compilePreactMx`/`compileReactMx`/`compileHonoMx`, so the virtual code (never the build output) wraps native event handlers as `(fn) satisfies Handler<"tag", "event">`, a type-only form that TypeScript erases on emit — `mx-tsc` emits JavaScript from this same projection, so no helper value or call may ever appear in it (`jsx-handler-emit.test.ts` emits and runs each host). The host's handler type is looked up case-insensitively in its `JSX.IntrinsicElements`; an unknown prop, custom element or dynamic tag is unchecked. A shorthand handler has no source span of its own, so its generated function maps onto the attribute name and errors inside its body land on that name. `mx-tsc` tests: `packages/tooling/tsc/src/jsx-handler-typing.test.ts` (shared sources in `src/fixtures/handler-typing`, one throwaway project per host).
