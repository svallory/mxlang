# `packages/stock-marko` (`@mxlang/stock-marko`, private)

Proof package for the MX2 brief (`notes/briefs/mx2/stock-marko-reference.md`).
It holds the stock, unpatched `htmljs-parser` 5.18.0 and proves — by
running both parsers over identical inputs — where the root `patchedDependencies`
patch diverges MX's parser from the published build.

## Source identity (decision 157.3)

- `vendor/htmljs-parser-5.18.0.tgz`: the published npm tarball
  (`sha512-ANKBAi2UyiQ…` — same integrity `bun.lock` records for
  `htmljs-parser@5.18.0`).
- Extracted to temp on first use (`vendor/`); never installed as an
  npm-alias (an alias lands patched — measured 2026-10-06).
- The loader hook (`run-stock-marko.cjs`) is confined to the child
  process that runs the stock parser; it never leaks to the repo's
  built packages.

## Public surface (`src/index.ts`, `src/probe.ts`)

- `stockParse` / `stockEvents` / `mxEvents`: compare event streams.
- `probe`: CLI (`bun run probe`) that prints each divergence row.
- `stockMarkoCompile` / `stockMarkoTree`: compile and AST-level proofs
  (`marko.test.ts`).
- `divergence.cases.ts`: the 25-row event-level table, 3 tree-level
  rows, 5 controls — pinned in `divergence.expected.json` (generated
  with `GRAMMAR_SPEC_UPDATE=1`, never hand-typed).

## Proof coverage (see `divergence.test.ts`)

- Vendor integrity (tarball sha512 == `bun.lock`).
- Patch-marker absence (`vendor.test.ts`).
- Forward-patch equality: vendored bytes + `patches/htmljs-parser@5.18.0.patch`
  == installed `dist` byte-for-byte.
- Core isolation (`packages/core` resolves the patched parser — verified).
- Table: ≥20 event-level differences (after-value, atoms, non-ASCII,
  NBSP, never-throw), 3 tree-level rows (`<a:b/>`, `<div :x/>`,
  `<a.hover:x/>`), 5 equal-stream controls (`copyright-ambiguous`,
  `nbsp-before-comment`, etc.).

## Tests

- `vendor`: integrity + forward-patch equality.
- `stock`: `stockParse` + event streams.
- `marko`: `stockMarkoCompile` / `stockMarkoTree` + isolation.
- `divergence`: the pinned table (`expected.json` is the observation).

All 57 pass locally (`bunx vitest run --root ../.. --project @mxlang/stock-marko`).
