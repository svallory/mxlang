# target-registry — agent instructions

## `@mxlang/target-registry`: the built-in target table

Private package (decisions 129 and 132; **unstable**, like the contract in
`@mxlang/core`'s "Target contract" section). It statically imports each host
package's `./descriptor` subpath and exports:

- `builtinTargets`: the eight built-in `TargetDescriptor`s: the seven hosts in
  `mx.host` order (`html`, `astro-html`, `solid-jsx`, `preact-jsx`, `react-jsx`,
  `hono-jsx`, `angular-template`), then the hostless `data` (no host, no file
  kinds, no `mx.host` value, no `mx.tags[].hosts` filter key).
- `builtinTargetLookup`: `createTargetLookup(builtinTargets, { reservedNames: ["astro-template"] })`.
  `astro-template` is reserved for the Astro template output, `.astro.mx` (design note §8 Q5; decision 134 made it a file kind of the `astro` host); the
  reservation lives here because core names no target.
- `BuiltinFileKind` and `builtinFileKinds`: core's `HostFileKind` plus
  `pipeline: "region" | "ng-template" | "astro-template"`, the key of the editor pipeline that
  serves the file kind. The pipeline key is tool glue and never goes into
  core; `PIPELINES` maps a segment to it, and a built-in file kind with no
  entry throws at import.

**Nothing consumes the registry yet.** Tooling still reads the closed lists
(`HOST_NAMES`, `HOST_PACKAGES`, `HOST_MODULE_SEGMENTS`, `MX_ATTR_TAG_SOURCES`,
`SOLID_MX_LANGUAGE_IDS`, the per-host compile branches). `src/parity.test.ts`
compares every descriptor field with those constants (each `file:line` is in a
comment), so the change that switches the consumers can delete them with proof.

## Light import

Importing the registry or any descriptor must load no `@marko/compiler` and no
`@astrojs/compiler`. A descriptor imports only its declarations (policy tables
and emitters' declaration objects) and reaches the compile entry inside
`load()` with `require("./index.ts")` on a **relative** path, so Bun inlines it
in a bundle. (Cross-package: `astro-html` requires `@mxlang/html` by name; a
literal bare `require` is bundled too.) `src/light-import.test.ts` runs a
fresh `bun` process, lists the compiler modules in `require.cache`, and checks
the detector with a positive control (compiling once loads `@marko/compiler`).
`@babel/parser` does load (Solid's emitter and `@mxlang/parser` import it); it
is not a compiler.

Do not add a top-level import of a host's `index.ts` to a descriptor, and do
not call `createTranslator`-style work at import time. `html`'s `translator` is
a getter so it stays lazy.

## Where the descriptors live

Each host package owns `src/descriptor.ts` and `package.json#exports["./descriptor"]`.
`@mxlang/html` and `@mxlang/angular` ship `dist`, so their build lists
`src/descriptor.ts` as an entry (and html's `distFiles` in
`scripts/pack-hygiene.ts` names `dist/descriptor.{js,d.ts}`). The registry is
not in `PACKED_PACKAGES`: it is private with `main` at source and nothing
ships it; the pack probe stubs it for consumers (`STUB_PRIVATE`).

## Running

```
bunx vitest run --project @mxlang/target-registry
```

It needs a built `dist` for `@mxlang/core`, `@mxlang/html` and `@mxlang/angular`.
