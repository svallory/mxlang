# vite-plugin — agent instructions

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
mock the dynamically imported host inside `vi.resetModules()` and dynamically
import a fresh plugin instance. Rebuild `packages/core/dist` before running
these tests, because this package resolves core through its built entry.

After Vite resolves configuration, the plugin builds a synchronous resolver
from `resolve.alias` and passes it through each `.mx` host compiler so core's
callee reader sees the same aliases as Vite. `.solid.mx` uses a fresh
`mxRegionCompile` closure per transform: it collects each `compileSolidMx`
result's dependencies and records their union in the same reverse map as
whole-file `.mx` compiles. A global closure would mix callers' dependency
sets and make pruning stale edges impossible.
