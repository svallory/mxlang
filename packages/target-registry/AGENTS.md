# target-registry — agent instructions

## `@mxlang/targets`: the built-in target table

Private package (decisions 129 and 132; **unstable**, like the contract in
`@mxlang/core`'s "Target contract" section). It statically imports each host
package's `./descriptor` subpath and exports:

- `builtinTargets`: the eight built-in `TargetDescriptor`s: the seven hosts in
  `mx.host` order (`html`, `astro-html`, `solid-jsx`, `preact-jsx`, `react-jsx`,
  `hono-jsx`, `angular-template`), then the hostless `data` (no host, no file
  kinds, no `mx.host` value, no `mx.tags[].hosts` filter key).
- `builtinLookup()`: `createTargetLookup(builtinTargets, { reservedNames: ["astro-template"] })`, built lazily and cached. `lookupFor(policy)` adds a loaded third-party descriptor to it.
  `astro-template` is reserved for the Astro template output, `.astro.mx` (design note §8 Q5; decision 134 made it a file kind of the `astro` host); the
  reservation lives here because core names no target.
- `BuiltinFileKind` and `builtinFileKinds`: core's `HostFileKind` plus
  `pipeline: "region" | "ng-template" | "astro-template"`, the key of the editor pipeline that
  serves the file kind. The pipeline key is tool glue and never goes into
  core. A kind with a `compileRegion` is `region` whatever its segment;
  `PIPELINES` maps the template segments (`ng`, `astro`), and a built-in
  file kind with neither throws at import.
- `regionFileKinds(lookup?)`, `regionFileKind(file, lookup?)`,
  `regionCompileFor(file, options)` (decision 154): the region file kinds of
  a lookup (the built-in one, or `lookupFor(policy)`), the one a file's exact
  `.<segment>.mx` suffix names, and the parser hook that lowers its regions.
  Every tool routes region files through these, never by a segment name. An
  unregistered `.<word>.mx` and a kind without `compileRegion` (a template
  kind, or a third-party host such as Mesh's on data) are never region files.

**The registry is the only dispatch table.** Core's former closed lists
(`HOST_NAMES`, `HOST_PACKAGES`, `HOST_MODULE_SEGMENTS`, `MX_ATTR_TAG_SOURCES`,
`SOLID_MX_LANGUAGE_IDS`, the per-host compile branches) are deleted. The
language server, the TypeScript plugin (and `@mxlang/tsc` through it) and the Vite plugin
dispatch through `builtinLookup()` (or `lookupFor(policy)` when a project
loaded a third-party target through `mx.target`). Adding a target means adding
a descriptor, not a branch in a tool. `src/parity.test.ts` pins every
descriptor field against the resolution, scanning and tooling rules those
lists encoded.

Published tooling declarations must not reference this private package; keep
registry-typed helpers internal to each tool's build.

## The umbrella (decision 201)

The package is `@mxlang/targets`, the umbrella of the `target-*` family: the
registry plus every target. Its directory stays `packages/target-registry`.
Beyond the registry it adds:

- `htmlTarget` on the main entry: the html target's descriptor, the same
  object `builtinTargets` registers. It is light like the rest of the entry.
- `@mxlang/targets/html` (`src/html.ts`): `export *` of `@mxlang/target-html`'s
  full entry (`compile`, `compileFile`, `policy`, …). It stays a subpath because
  that entry reaches the compiler, and the main entry must load none.

`@mxlang/data` is not part of the umbrella and keeps its name: decision 204
deletes it. The package stays private 0.0.0 with `src` entry points; making it
publishable is release track C. `src/umbrella.test.ts` pins the export map and
the identity of every re-export.

## Light import

Importing the registry or any descriptor must load no `@marko/compiler` and no
`@astrojs/compiler`. A descriptor imports only its declarations (policy tables
and emitters' declaration objects) and reaches the compile entry inside
`load()` with `require("./index.ts")` on a **relative** path, so Bun inlines it
in a bundle. (Cross-package: `astro-html` requires `@mxlang/target-html` by name; a
literal bare `require` is bundled too.) `src/light-import.test.ts` runs a
fresh `bun` process, lists the compiler modules in `require.cache`, and checks
the detector with a positive control (compiling once loads `@marko/compiler`).
`@babel/parser` does load (Solid's emitter and `@mxlang/tsx-bridge` import it); it
is not a compiler.

Do not add a top-level import of a host's `index.ts` to a descriptor, and do
not call `createTranslator`-style work at import time. `html`'s `translator` is
a getter so it stays lazy.

## Where the descriptors live

Each host package owns `src/descriptor.ts` and `package.json#exports["./descriptor"]`.
`@mxlang/target-html` and `@mxlang/host-angular` ship `dist`, so their build lists
`src/descriptor.ts` as an entry (and html's `distFiles` in
`scripts/pack-hygiene.ts` names `dist/descriptor.{js,d.ts}`). The registry is
not in `PACKED_PACKAGES`: it is private with `main` at source and nothing
ships it; the pack probe stubs it for consumers (`STUB_PRIVATE`).

## Running

```
bunx vitest run --project @mxlang/targets
```

It needs a built `dist` for `@mxlang/core`, `@mxlang/target-html` and `@mxlang/host-angular`.
