# Mesh's golden parse corpus

Every entity file and every `mx` doc block of Mesh, copied with attribution
as a parse fixture for the syntax modules (decision 183 addendum 6; Mesh's
review of PR 460, F2). The test is
`packages/core/src/ir-entry/mesh-corpus.test.ts`.

## Source

- Repository: `https://github.com/svallory/mesh`, branch `main`, commit
  `583150be044289d991e75312577727f8dca99405` (2026-10-09, "docs(entities): a
  check may read a related record; check versus policy").
- Licence: MIT, Mesh's own, copied unchanged into `LICENSE`. The copied files
  keep that licence.
- Mesh's review of PR 460 counted 20 doc blocks at its commit `220ff58`; this
  copy is from a later commit and has 22.

## Layout

- `entities/<path in Mesh>`: the 41 `.mesh.mx` files under Mesh's
  `examples/blog/src/domain/blog/` and `packages/compiler/test/fixtures/`
  (`fix1/`, `negative/`, `src/domain/billing/`, `post.mesh.mx`), byte for
  byte.
- `docs/<page under apps/docs/docs>.<n>.mesh.mx`: the 22 ```` ```mx ```` fences
  of Mesh's docs, with or without a `"title"` (the `mx-figure`/`mx-flow`
  fences are diagrams, not entity source, and are left out), numbered in page
  order from 1 and dedented. Nothing else is changed.
- `contracts.ts`: Mesh's `packages/compiler/src/contracts.ts`, the closed
  contracts its compiler parses with. Only the import lines differ: core's
  types come from core's own source, and `@meshfw/model`'s two lists from
  `./model.ts`. The file was then formatted by this repo's Biome, which
  changed layout only.
- `model.ts`: the two lists the contracts read from `@meshfw/model`
  (`ACTION_TYPES`, `ATTRIBUTE_TYPES` with each type's `tsType`), copied.
- `__golden__/golden.json` (left out of Biome, like every `__golden__`):
  the whole `LowerSourceResult` of every file (the IR `lowerSource`
  returns, or the diagnostics when it has none), lowered as Mesh's
  `parseEntitySource` parses (`syntax: @mxlang/core/syntax/mesh` with
  `productName: "Mesh"`, the contracts above, `structural: "reject"`,
  `unknownTags: "reject"`, `imports: "pass"`), under the virtual path
  `/mesh-corpus/<file>`. Two reductions keep it readable: the IR's `loc`
  (restated by every `span`) is dropped, and each parser (Babel) node keeps
  its shape and the `mx*` marks on its `extra` but not its offsets (`start`,
  `end`, `loc`, `range`), which the spans and the marks already carry. The
  golden pins every diagnostic and every tag name, count and span.

## Updating

Re-copy from a new Mesh commit by the same rules, update the commit above,
then regenerate the golden and review its diff:

```sh
MESH_CORPUS_UPDATE=1 bun x vitest run packages/core/src/ir-entry/mesh-corpus.test.ts
```

Slice c (the deletion of core's built-in atoms and sugars) must pass the
golden test unchanged; a change to the golden in that slice is a
behaviour change and needs a ruling.
