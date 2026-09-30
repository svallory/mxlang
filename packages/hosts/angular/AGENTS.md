# angular — agent instructions

## `@mxlang/angular`: the Angular host on `@mxlang/core` (in progress)

`packages/hosts/angular` emits an Angular template string from a `.mx` page
template (`compile()`, `src/index.ts`); the emitter (task 1.3) covers every
structural kind. See `notes/investigations/angular-host-design.md` for the
design (A1: the lowering table; A3: the CLI).

`bun run oracle:angular` (`packages/oracle/src/report-angular.ts`,
`runAngularTable`) is the oracle table: each fixture under
`packages/oracle/fixtures/angular/<name>/` is either a **pass** fixture
(`input.mx` + `expected.html`, byte-compared to the emitted template, plus
`expected.warnings.txt` for a fixture whose A1 row is a Warning — one
message per line, byte-exact, in emission order; absent means zero
warnings) or an **error** fixture (`input.mx` + `expected.error.txt`,
matched exactly against the `TranslateError` message with `compile()`'s
absolute-path prefix stripped). Every pass fixture is additionally checked
against the real `@angular/compiler@22.1.7`:
`parseTemplate(emitted, name).errors === null` and a span-stripped AST
snapshot in `packages/oracle/fixtures/angular/__golden__/<name>.ast.json`
(regenerated with `--update`). `bun run oracle` runs this table too (after
its own Solid twin table) and folds its result into the exit code, and
`packages/oracle/test/angular.test.ts` runs it through `bun run test` /
`bun run verify` so a regression here fails CI, not only a developer's own
`oracle:angular` run. A third kind joined the two above in task 1.7: a
**tag** fixture (`input.mx` + `expected.ts`) compiles through
`compileTagModule` and byte-compares the emitted component module, then
extracts its `template:` string and puts that through the same
`parseTemplate` gate. A tag fixture is staged under its *own* basename (the
directory name minus `tag-`), since a tag's selector and class come from its
filename and `input.mx` would name every component `Input`; a fixture with
its own `tags/` directory is staged in a temp directory with a
`package.json` boundary, because discovery walks upward from the compiled
file. See `packages/oracle/fixtures/angular/README.md` — its "rows
intentionally absent" list is now empty — and the `<for in=>` ordering
rationale.

**`mx-angular build`/`map` (task 1.5a); `watch` (task 1.5b, incremental).**
`mx-angular build [--project <dir>] [--config <file>]` (`src/cli.ts`) reads
`package.json#mx.angular` (`include`, `pageExtension`, `tagExtension`,
`tagSelectorPrefix`, `onError` — A3's defaults; an unrecognized key is a
positioned error naming it) and compiles `include` ∪ the discovered tag
index (a `.mx` file under any `tags/` directory or `package.json#mx.tags`
entry). `src/discover.ts` gets this from `@mxlang/core`'s
`discoverProjectTags(projectDir, { host: "angular" })` — the project-wide
enumerator (`packages/core/src/scan.ts`), reused rather than reimplemented,
so the `hosts`-filtering rule and the manifest reader stay in one place. Its
boundary is core's own: a nested directory holding its own `package.json`
(other than `projectDir` itself) is a separate project, and its `tags/`
directory is not discovered from here — a behavior narrower than the
watcher's own former hand-rolled walk, which continued past a nested
`package.json` and merely switched which `mx.tags` governed what it found
underneath. A page compiles to `pageExtension` beside its
source, with a generated-header comment (a second line naming the
`import`/`imports:` to add per called MX tag, when the compiled template
called at least one — sourced from the emitter's own `usedTagNames()`, not
parsed out of its warning text) and a `.map` sidecar carrying a **real**
source-map v3 (task 2.2b). The emitter records a span per run of
source-derived text — tag and attribute names, every expression; literal
text runs deliberately not — exposed as `compile().mappings` and encoded
into the map, so `mx-angular map` resolves `file.html:line:col` to
`source.mx:line:col`. Two invariants: a mapping is **whole-to-whole** (the
entire generated run maps to the entire source span, never character by
character), which is what keeps it correct when escaping changes the
generated length — so a position *inside* an expression resolves to that
expression's start; and a position in generated punctuation resolves to
nothing and is reported as such rather than fabricated — each run is
bounded by a terminator segment in the emitted v3 map, so a position *after*
a run does not inherit it (the encoder emits one segment at each run's start
and a source-less one at its end; `@jridgewell/sourcemap-codec` does the
encode/decode). A run whose text is *derived* rather than copied (selector,
DOM event name, `track` expression, `<define>` param, `[ngClass]`/`[ngStyle]`)
carries an angular-local `AngularMapping.derive` tag (`src/mapping.ts`,
`MappingDerive`), threaded through the rebase helpers; the oracle's
mapping-alignment check (`isDerivedFrom`) verifies each such run against the
one derivation its tag names, exactly, and treats an untagged run as a copy
that must un-escape to its source. Record `derive` at the emission site of any
new derivation, or the oracle rejects the mapping. `buildMap` shifts
the map by the generated header's line count, since the sidecar describes
the file on disk while the compile map is template-relative. A *discovered*
tag call has no `nameSpan` (core derives it from the gensym'd binding it
minted), so its selector is emitted unmapped. Every warning
`compile()` produces prints to the terminal, `file:line:col warning: ...`.
**A discovered tag file compiles to a component module** (task 1.7,
`src/tag-module.ts`'s `compileTagModule`): a `.mx` under `tags/` emits
`tagExtension` (`.ts`) holding a standalone `@Component` — inputs from
`export interface Input` (`required: true` when not optional, the type
copied verbatim, **no `@Output()` inference**), `<ng-content>` for
`${input.content()}` and `<ng-content select="[x]">` for a projected
attribute-tag render (repeating one is an error: Angular matches each selector
once), `mx-` +
kebab-cased basename as the selector unless the tag exports its own, and
the tag's `static`/`import` placed at module scope. The class is named by
core's `exportNameFor`/`moduleExportName` (tag-unit 2b), the same
derivation every module-emitting host uses. The *template* is built by the
page emitter, so the two output kinds cannot disagree about how a construct
lowers. Two things the emitted module must get right, both measured rather
than assumed: a template reads an input by its **bare name**, because
Angular resolves against the component instance — emitting
`{{ input.name }}` parses cleanly and renders **empty** (`parseTemplate`
cannot catch it, so the tests assert the expression text); and a
*discovered* tag reaches the emitter under a gensym'd binding
(`$mx_Icon1`, `template-tag.ts`'s `bindingForTemplate`), so the selector is
resolved through the import's specifier rather than from
`Component.target.name`, which would emit the invalid `<mx-$mx-icon1>`.
The rewrite covers `input.x`, `input?.x` (a distinct
`OptionalMemberExpression`), `input["x"]`, nested `input.a.b` and arrow
bodies, and honours every binder that shadows the name — a `<for|input|>`
param (read off the core's `For.bindings`; `params` beside it is *source
text* and never matches), a `<const/input=…>` (sequentially, as the emitted
`@let` rebinds from that point), a function parameter and a destructuring
pattern. `input[k]` is a positioned error. `Input` itself is parsed with
Babel (the core's own instance) taking each type as a verbatim source
slice; the text scan that stood here first dropped newline-separated
properties, mis-sliced arrow types and broke on comments. Projected `AttrTag`
content may be rendered only through `${input.x()}`,
`${input.x.content()}`, `<${input.x.content}/>` or `<${input.x}/>` for a
renderable declaration (including optional-chain forms). Any other read of a
declared projection is a positioned error rather than the silent blank an
unbound `never` input would produce. The older inferred-slot safeguards also
remain: a name read both as a slot and bare, a slot called with arguments, and
a slot passed through as an attribute are errors. An authored `import Child
from "./child.mx"` is emitted once,
by MX, pointing at the generated module — `isTagModuleImport` is the one
rule both halves consult so they cannot disagree and emit it twice.
`mx.angular.tagSelectorPrefix` is wired through both entry points.
Calling a discovered tag from a page is no longer the module-level error:
the synthesized `Import` is resolved to a component reference, while an
**author-written** `import`/`static`/`export` still is one. Only writes an
output when its bytes differ,
and refuses to overwrite any output — page or tag — lacking the generated
header (`checkOverwriteGuard`, `src/build.ts`, wired into `build()` itself,
not merely exported for direct testing — including the `onError` failure
path: a compile error never overwrites or deletes a hand-written file at
the output path, in any of the three modes). A tag-template's own compile
error carries `file` pointing at the tag, not the caller, and is reported
against that file (A5). Containment checks resolve real paths
(`fs.realpathSync`), not merely normalized ones, so a symlinked `tags/`
directory or output path cannot be used to read or write outside the
project directory.

**`.ng.mx` (phase 2, `src/ng-mx.ts`'s `compileNgMx`)** is a third output
kind: an ordinary TypeScript module whose `@Component` template is MX,
emitting `<basename>.ts` beside the source (`mx.angular.ngExtension`,
default `.ts`). The parser finds each region and hands it to this host
through the generic `mxRegionCompile` hook, with `mx: true` (a `.ng.mx`
filename never matches the parser's own `.solid.mx` extension test) and
`ngMxPositionCheck`, which rejects every position but the direct value of
`template:` in `@Component({ … })`'s **first** argument — all four
`MxRegionContext` fields are load-bearing, `argumentIndex` being the only
one that separates `@Component({ template })` from `@Component(opts, {
template })`. The template is emitted as a **backtick literal** with
`` ` ``, `${` and `\` escaped (decision 99, reversing A4 divergence 3;
spike §Q3 measured that a double-quoted emit puts Angular's diagnostics in
escaped coordinates and forces an inverse hop at every newline, while
backticks are 1:1). Unlike a page, this host **owns the module**, so it
appends every used MX tag and every needed Angular directive to the
decorator's own `imports:` array *and* emits their `import` statements —
A4 divergence 5, the one AST edit no other host performs — and the
emitter's "add X to the component's imports" warnings are dropped here,
since MX just made that edit. **Authored `import`/`static`/`export` are
written in the surrounding module, not inside a region**: a region is
TypeScript expression position, where those are statement syntax and the
vendored Babel rejects them before MX sees the file (A4 divergence 4,
amended by the lead 2026-09-17 after this was measured; pinned by three
rejection tests). Only a *synthesized* discovered-tag import hoists, via
`MxRegionCompileResult.hoistedImports`. `result.mappings` carries the real
per-region spans (task 2.2b): each region's expressions and names are mapped
against their own literal, then rebased onto the finished module by where
that literal landed.

**The emitted `.html` (and, once 1.7 lands, tag `.ts`) files are generated
artifacts**: `.gitignore` them, and run `mx-angular build` (or `mx-angular
watch`, for a long-running dev loop) *before* `ng serve`/`ng build` —
Angular's own template resolution needs the emitted file to already exist
on disk; there is no in-memory hand-off. Exclude `.mx` sources (not emitted
tag `.ts` modules) from `tsconfig.json` and from `angular.json`'s `assets`
array.

**`mx-angular watch`** (`src/watch.ts`, `startWatch(projectDir, options)`)
runs the initial `build()`-equivalent pass, then an incremental loop:
`fs.watch` on `include` ∪ every discovered `tags/` directory (`discoverFiles`'s
new `tagDirectories`, since a `tags/` directory holding only a sidecar
`.tag.ts` — no `.mx` template — never appears in `files`, which is `.mx`
only) ∪ the project root (for `package.json`), one non-recursive watcher per
directory (portable across platforms rather than relying on macOS/Windows-only
recursive support), debounced 50ms per A3. Dependency tracking: each page's
last compile records the `usedTags` names the IR actually kept (a
`Component` node survived); a sidecar `transform` returning IR directly
(a macro, per `@mxlang/core`'s own docs "the only expansion left in the
language") leaves no `Component` node and therefore no `usedTags` entry, so
`recordDeps` also scans the page's raw source for every discovered tag name
as a literal `<name` occurrence — a deliberate over-approximation (a
spurious rebuild costs nothing; a missed one silently serves stale output).
A changed page recompiles only itself; a changed tag path (template or
sidecar) recompiles every page whose recorded dependency set contains it; a
`package.json` change, or an `.mx` file appearing/disappearing outside the
already-routed set, triggers a full rebuild, since either can change
routing itself. `onIdle` cannot fast-path on "nothing pending right now" —
a caller reads it right after a synchronous `writeFileSync`, before
`fs.watch`'s genuinely-async delivery has necessarily fired — so it polls
for a *quiet* window (no debounce timer, no in-flight rebuild) sustained for
`max(100ms, debounceMs * 4)`, long enough to absorb realistic `fs.watch`
delivery latency without becoming a fixed sleep. `--once` skips starting any
watcher and resolves `onIdle` off the initial build alone (for CI and tests).
The CLI's non-`--once` path resolves on `SIGINT`/`SIGTERM` (`Ctrl-C`, exit
0).

### Event handlers (decision 117)

An element event handler is emitted as a call through two `protected` invoker
members on the component, `__mxOn(handler, receiver, $event)` and
`__mxOnAt(object, 'key', $event)` (`EVENT_HELPER_MEMBERS`, `src/emitter.ts`), so
a 0-arg, 1-arg or 2-arg `(event, element)` handler type-checks under
`strictTemplates` and its return value reaches Angular. The receiver comes from
the parsed expression (`handlerShape`), never a regex: a bare name is `this`,
`a.b` is `a` evaluated once. The members are inlined (this package has no
runtime): `.ng.mx` injects them into the decorated class, a tag module writes
them into its class, and a page's own class gets a once-per-file warning
(`EVENT_HELPER_ADVICE_CODE`) with the text to paste. `this` is the component and
`element` is `$event.currentTarget` as `EventTarget | null` — both recorded in
`divergences.md`. The tests check the emitted template with ngtsc
(`test/event-handler.test.ts`, via `@mxlang/angular-checker`).

### Attribute tags (decisions 106–107)

This host declares `attrTags: 2` and emits component projections only from
core's resolved `attrTagProps` plan. A singular tag is an
`<ng-container ngProjectAs="[name]">`; a singular plan under
`<if>`/`<else if>`/`<else>` is wrapped in Angular `@if` blocks, preserving
branch exclusivity. Arrays (including an absent declared `AttrTag[]`),
attributes, params, and nested attribute tags are positioned errors naming
`@mxlang/angular`, because projection is keyed by selector and carries nodes,
not an object or callback. A bodiless `<@name/>` is also an error because there
are no nodes to project.

The callee receives no run-time attribute-tag value: each supported render
idiom above is compiled directly to `<ng-content>`. Any other read (a
condition, pass-through, property read, and so on) errors with a fix-it naming
`<${input.x.content}/>`. `@mxlang/angular` therefore exports `AttrTag<C>` as a
`never` projection marker used by core's syntactic `Input` reader; tag-module
generation excludes every declared projected property from `@Input()` fields
and auto-imports the marker type when needed. `as: "data"` and
`as: "renderable"` intentionally select the same projection on this host.
