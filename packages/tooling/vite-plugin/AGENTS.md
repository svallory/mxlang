# vite-plugin — agent instructions

## Current target dispatch (decisions 129/132)

Whole-file `.mx`/claimed `.marko` compilation selects
`lookupFor(policy).target(policy.target)` (a descriptor loaded from a package
specifier included) and calls its lazy `load(core).compileModule` with
`targets: lookupFor(policy)`. No host-name
compiler branches remain. The registry itself is cached behind a dynamic
import; config evaluation loads no registry or heavy compiler. Build startup
installs the registry's lazy callee readers, not a host index for its side
effects. The `.solid.mx` path selects the registered `region` pipeline and
collects its compile dependencies per transform, retaining parser `print()`.

D1 stays caller-owned: `options.strict ?? false` reaches the descriptor even
when its `strict` is `"always"`. D2 stays in descriptor option forwarding:
HTML/Astro and Preact/React/Hono forward Vite's synchronous resolver, while
Solid's descriptor retains its existing omission. D4 comes from absent
`load`, `host.name` and `pending`, keeping Angular's message byte-identical.
Data remains staged out by the registry's policy wrapper. Whole-file output
still returns `map: null`, so absent map/mappings are safe. There is no editor
type-surface rewrite or `typeCheck` option on this build path.

The package stays private but `main`/`exports` and `types` point at `dist`.
Its ESM facade loads a relocatable CJS bundle of registry/descriptors/host
glue, keeping core, parser and `@marko/compiler` external (PR 4/5 precedent).
A direct ESM bundle hoists data's external compiler import out of its lazy
leaf; the CJS closure preserves deferred evaluation. Descriptor `require()` calls
must not escape into source-loaded ESM under native Node. `@marko/compiler`
is an exact-pinned direct runtime dependency; Vite is an exact-pinned peer
because the public `Plugin` type comes from it. No host-package dependencies
remain. Root and moon builds delegate to the same package build, before
consumer tests/examples. Only `dist/index.d.ts` is emitted; it must import
neither private registry types nor descriptor subpaths.

Dispatch goldens use the built runtime, without snapshot updates. The plain
Node dist regression covers every wired page target and a region; the light
import regression also uses dist under plain Node and checks that config
loading/reader registration load no compiler, with a first-transform positive
control. Pack hygiene/probe include this private artifact and a packed Node
smoke with a stubbed registry. Source unit tests still intercept descriptor
loads/region entries; their project externalizes core/dist so native requires
share the plugin's caches/readers.

Historical implementation details below predate table dispatch.

## Vite plugin

`packages/tooling/vite-plugin` (`@mxlang/vite-plugin`) is the primary integration
(spec section 7.1): an `enforce: "pre"` Vite transform that prints
`.solid.mx` to JSX source text with `print()` ahead of
`@solidjs/vite-plugin`. Both plugins are `enforce: "pre"`, so their relative
order is their order in the `plugins` array — `mx()` must come first.

`mx()`'s default `extensions` is `[".solid.mx", ".mx"]`: `.mx` (the official
and only template extension — `.marko` is not accepted, see "`.mx` is the
only template extension" in `packages/parser/AGENTS.md`) compiles through `compileMarko()` (routing
to the resolved host's compiler — `@mxlang/html`'s `compile()`,
`@mxlang/preact`'s `compilePreactMx()`, etc.) instead of `print()`, to a
plain `(input) => string` module or a JSX component module per host —
`suffixFor` returns `.tsx` for every handled extension (it used to pick
`.ts` for the `.mx` path): the suffix has to be decided identically by
`resolveId`, which holds the real path, and `isMxModule`, which holds only
the suffixed one — and the host is a property of the file's nearest
`package.json`, so deriving it in both places would mean resolving a policy
from a path that does not exist on disk. A `.tsx` file containing no JSX is
ordinary TypeScript and rolldown's transform over it is a no-op. `.solid.mx`
is otherwise byte-for-byte unchanged by this: same suffix, same `print()`
call, same source map, and it keeps precedence over `.mx` regardless of
`extensions` order (`.mx` is a literal string suffix of `.solid.mx`, so the
longest-first sort at `index.ts`'s `matchExt`/`isMxModule` setup matters
here). The `.mx` path returns `map: null` from `transform` — `compile()`'s
map is presently an identity placeholder (see `packages/hosts/html`'s own
doc comment: no AST is printed on that path), so there is nothing real to
hand Vite yet.

`compileMarko()` inside the plugin dynamically `import()`s
`@mxlang/html` rather than importing it statically at module top level,
and this is load-bearing, not a style choice: `@mxlang/html` has no
compiled entry (`main` is `src/index.ts`), and its `translate.ts` pulls in
`@marko/compiler`. A static import would load that dependency the instant
`vite.config.ts` imports this plugin — including for a `.solid.mx`-only
project like `examples/counter-app` that never touches `.mx` — and
previously broke `vite build` for such projects, because Vite's own config
loader (and, separately, Node's plain `import()`/`require()`) reads
TypeScript through Node's native strip-only mode, which used to reject a
`readonly` parameter property in `TranslateError`'s constructor (fixed to
plain fields, since it is public API a no-build-step consumer can hit
directly). A dynamic `import()`, not `require()`: `require()` on a bare
specifier whose `main` is TS source goes through Node's native loader with
zero transform under a Node-native `require` (e.g. inside a Vitest test),
hitting the same class of error one import further in; dynamic `import()`
goes through Vite's/Vitest's own transform pipeline, which strips TypeScript
fully.

Any consumer of this plugin needs `allowImportingTsExtensions` in its own
`tsconfig.json`, even one that only writes `.solid.mx`: resolving
`@mxlang/html`'s types at all — even through the plugin's own dynamic
`import()`, cast away at the call site — means `tsc` walks that package's
`.ts` source, which needs the flag wherever it lands. `examples/counter-app`
and `examples/todomvc` both carry it for exactly this reason, not because
either project imports `.ts` paths itself.

`resolveId` rewrites the resolved path to `<path>.solid.mx.tsx` and `load`
reads the real file from disk. That suffix is not cosmetic; three separate
stages dispatch on the file extension and `.solid.mx` satisfies none of them:

1. Vite routes a module into the JS pipeline only when the extension matches
   `JS_TYPES_RE` (`/\.(?:j|t)sx?$|\.mjs$/`). With no `resolveId` hook the
   import is never resolved and `transform` never runs at all.
2. Rolldown picks its parser dialect from the extension, so printed JSX is
   parsed as plain JS ("Unexpected JSX expression"). Returning
   `moduleType: "tsx"` fixes the parse but then hands the module to
   rolldown's own JSX transform, which resolves `react/jsx-runtime`.
3. `@solidjs/vite-plugin` only compiles ids passing its `filter`, default
   `src/**/*.{jsx,tsx,tsrx,ts,js,mjs,cjs}`. That test runs *before* its
   `options.extensions` list is consulted, so registering `.solid.mx` there
   cannot bring the file back in.

The `.tsx`-suffixed id satisfies all three at once, which is why the
example's `vite.config.ts` is just `plugins: [mx(), solid()]` with no Solid
configuration.

The suffixed path is produced by Vite's own resolver, never by path
arithmetic in the plugin: `resolveId` calls `this.resolve(id, importer,
{ skipSelf: true })` and appends the suffix to whatever comes back. That is
what makes relative ids from nested importers, root-relative (`/src/x.solid.mx`)
and `/@fs/` ids, `resolve.alias` entries and bare specifiers into workspace
packages all work; computing the path locally got each of those wrong. Any
`?query` on the id is re-attached after the suffix, so `./A.solid.mx?raw`
still returns the file's text rather than the compiled module.

`load` claims the suffixed id only when the un-suffixed `.solid.mx` file
actually exists on disk. A real `Foo.solid.mx.tsx` checked into a project is a
different module and must not be shadowed by MX's virtual one, so when there is
no `Foo.solid.mx` beside it the hook returns null and Vite reads the real file. Diagnostics and source maps keep the original `.solid.mx`
filename: `transform` prints against the stripped path, and parse errors are
re-raised with a Vite-shaped `loc` (`{ file, line, column }`) so the overlay
points at the MX line.

**`tags/*.marko` imports (audit case h18).** Every host's emitter writes
Marko's own `import _badge from "./tags/badge.marko"` for a tag the scan found
(#187), and nothing else in a Vite build handles `.marko` — rolldown parsed the
raw file as JS ("Unexpected JSX expression"). `resolveId` therefore claims a
`.marko` id when its importer is an id this plugin rewrote (`isMxModule`: an MX
page, or a tag it already claimed, so tag-calls-tag chains work) and rewrites
it to `<path>.marko.tsx`, exactly as it does for `.mx`; `load` and `transform`
then run unchanged, so the tag compiles through `compileMarko()` with the host
of the tag's own `package.json`. `.marko` is deliberately *not* in `extensions`
(still rejected there): that list claims imports on sight, a stray `.marko`
import from plain TS must stay untouched, and `@marko/vite` is no substitute
(its output is a Marko runtime template, not the function the emitted call
expects; same shape the Bun loader's test gives `.marko` tags,
`packages/hosts/html/src/marko-tags.bun.test.ts`). `sourceExt()` is the
extension lookup for HMR (an edited tag invalidates its own module and the
callers recorded against it). Tests: `marko-tags-build.test.ts` (real
`vite build` + `createServer().ssrLoadModule`, output executed).

`@mxlang/parser`'s `main` is `dist/index.js`, not `src/index.ts`. Vite's config
loader externalizes bare imports, so a consumer that pulls the parser's TS
source makes Node load the vendored Babel tree, whose `const enum`s the
strip-only TypeScript loader rejects. `types` still points at
`src/public.d.ts`, so typechecking never needs a build; `bun run verify`
builds before it tests.

The plugin records two kinds of compilation evidence in one dependency-to-
caller map: custom-tag scan locations and `CompileResult.dependencies` from
core's callee-`Input` resolver. `handleHotUpdate` invalidates each suffixed MX
caller when either kind changes, because editing a callee's `Input` changes the
caller's generated attribute-tag shape even though Vite already has an ESM
edge to the callee module itself. Keep per-caller reverse sets for both sources
and prune old edges on every transform or deletion; otherwise a long-lived dev
server retains stale callers. Tests that need a non-empty compile dependency
spy on the descriptor's `load` or the registered region's `compileRegion`
inside `vi.resetModules()` and dynamically import a fresh plugin instance. Rebuild `packages/core/dist` before running
these tests, because this package resolves core through its built entry.

After Vite resolves configuration, the plugin builds a synchronous resolver
from `resolve.alias` and passes it through each `.mx` host compiler so core's
callee reader sees the same aliases as Vite. `.solid.mx` uses a fresh
`mxRegionCompile` closure per transform: it collects each `compileSolidMx`
result's dependencies and records their union in the same reverse map as
whole-file `.mx` compiles. A global closure would mix callers' dependency
sets and make pruning stale edges impossible.

**Fixed: `custom-tags-template-error-positions` (round 2).** `transform`'s
catch only reshaped an error into Vite's overlay shape (`.id`/`.loc`/`.frame`)
when `isSyntaxError(err)` — `err instanceof Error && "loc" in err`, true only
for the vendored Babel parser's own errors. A `TranslateError` raised while
compiling a tag template (`tags/x.mx`) has `.line`/`.column`/`.file` but never
`.loc`, so it fell through that check and was rethrown raw: no `.id`, no
`.loc`, no `.frame` — Vite's overlay had nothing to show at all, and
`.file` (the template's own path, spec §2's third position rule) was never
read. `transform`'s catch now handles `TranslateError` explicitly, before the
`isSyntaxError` branch: when `.file` names another file, it reads *that*
file's source (disk — no editor-buffer reader exists on this path, unlike the
TS plugin's `readSource`) and builds `.id`/`.loc`/`.frame` from it instead of
from the caller's `code`, so the dev-server overlay and a `vite build` failure
point at the template, not at wherever the call happened to sit in the caller.

**Compile errors are compact and located (audit items 11, 19).** Rolldown and
Vite print `error.stack` under the location, so an expected compile error used
to drag ~50 translator/Babel/rolldown frames into every failing build — ~1,450
tokens per failing `vite build` over the agent-feedback corpus, against ~65 for
`mx-tsc`. `transform`'s catch now routes the three errors about *authored*
source — `TranslateError`, Marko's `CompileError` and the vendored Babel parse
errors — through `locate()`, which sets `id`/`loc`/`frame` and replaces `stack`
with `Name: message`. Anything else (a bug in mx itself) is rethrown untouched,
stack included; a test pins that. Two details:

- A Marko `CompileError`'s `loc` is `{ file }` only, so it printed
  `page.mx.tsx:undefined:undefined`. The only source of its position is the
  `at <path>:L:C` line its message starts with (`markoPosition`, 1-based
  column, converted to the 0-based `loc.column` the rest of this plugin
  raises); its `label` becomes the message, since `loc` + `frame` replace the
  embedded path and code frame.
- `TranslateError` is also matched by name: it is raised from `@mxlang/html`'s
  copy of core, so `instanceof` is false after a module-graph reload and the
  error used to reach the log raw.

Not fixable here: rolldown builds the header (`[plugin mx] <id>:L:C`) from the
*module* id, so a build prints `page.mx.tsx`, not `page.mx` — `this.error({ id,
loc })` changes nothing (checked on rolldown 1.2.8) — and `vite build`'s CLI
prints its own ~7-frame stack for the aggregate `Build failed` error. `id`,
`loc.file` and the dev-server overlay do carry the authored path.

**Unresolved imports are located at the authored specifier (audit item 10).**
For an import that nothing resolves, rolldown raised `UNRESOLVED_IMPORT` against
the generated `page.mx.tsx`. The `.mx` path has no source map (`map: null`), so
that position could not be remapped; `resolveId` raises the error itself
instead. For an importer that is an MX module, an id the plugin does not claim
is probed with `this.resolve(id, importer, { skipSelf: true })` — what rolldown
would do next. A hit is **returned as is**, so the resolvers after mx run once
per import (returning `null` after the probe ran them twice: a resolver with a
side effect saw every import double); only a `null` answer throws, and
`external` is not `null`, so an explicit `rollupOptions.external` specifier is
still fine. (Vite's own resolver runs before ordinary plugins, so only a
`pre`-ordered plugin after mx sees an id the probe resolves.) The claimed
`.mx`/`.marko` branches throw on their own `null`. `findImportSpecifier` is a
small lexer over the authored source, not a text search: a specifier mentioned
in a `//` or `/* */` comment, or inside a longer string, is not the import. A
string counts only right after `from`/`import` or as the argument of
`import(`/`require(`; quotes close at end of line, so a `'` in template text
(`don't`) cannot swallow the file. When the specifier is not written as an
import operand (an import the emitter added) there is no authored position, so
nothing is thrown and rolldown reports it. Two traps: (1) in the dev server the
resolve happens while transforming the importer, and Vite (`_formatLog`,
Vite 8.2.2) rewrites the error it catches — it maps `err.loc` through the
importer's combined sourcemap as if generated-module coordinates (authored
`page.mx:2:17` came out `page.mx.tsx:7:14`) and stamps `plugin:
vite:import-analysis`. An error that already has `pluginCode` is returned
untouched, so this one carries the authored source there and `plugin: "mx"`.
Left over: import-analysis still sets a stale `pos` (offset into the generated
module) on it; nothing reads it once `pluginCode` is set. (2) a `vite build`
error is rolldown's `Build failed with 1 error` aggregate: it carries the
position in its message only (no `loc`/`id`), and vite's own ~7-frame stack
stays. The source is normalized to `\n` first, so a CRLF file's frame has no
`\r`. `loc.column` is 0-based (lead's ruling), so the build prints `1:17` for
what `mx-tsc` calls `1:18`. Not covered: a missing `?raw` file fails in `load`,
not in resolution. Tests: `unresolved-import-build.test.ts` (real `vite build`
and `createServer().ssrLoadModule`; error text is ANSI-stripped).

**`readTemplateSource(file, read?)` guards that read (round 3/4).** The
named file may no longer exist, or be unreadable, between the compile's own
read and this one — a failure here must not replace the real diagnostic
with a raw ENOENT, so the read is wrapped and returns `undefined` on
failure (costing only `.frame`, never the message/`.id`/`.loc`). It takes
an injectable `read` (default `readFileSync`) specifically so a test can
exercise that failure path by passing a reader that throws, rather than
racing a real file deletion against the compile's own earlier read of the
same file — an early version tried to distinguish the two reads through
`Error().stack` (`"at compileMarko "` as the anchor frame), which is
V8-stack-format-specific and breaks under a different engine's stack
grammar or a rename; see `bun-jsc-error-line-column` in the space's memory
for the same class of engine-format fragility. `@mxlang/astro`'s
`vite-templates.ts` mirrors this helper rather than importing it (the same
pattern it already uses for `codeFrame`), even though it could import
`@mxlang/vite-plugin` (it already depends on that package for its `mx()`
integration) — kept as a mirror since the two call sites' surrounding error
shapes (`TranslateError` vs. `AstroTemplateError`) differ enough that
sharing would need a third parameter or a generic, for one four-line
function.
