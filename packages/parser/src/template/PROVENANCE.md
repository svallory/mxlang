# Provenance: htmljs-parser

`src/template/` is a copy of `htmljs-parser`'s TypeScript source: the tokenizer
that reads MX templates (decision 158, which supersedes the compiler part of
decision 157 addendum 2). This directory is MX's own code now. Licence:
`LICENSE` (MIT, copied from upstream).

It is **not wired into core**. Core still parses through `@marko/compiler`
and the `patches/htmljs-parser@5.18.0.patch` entry in `patchedDependencies`.
`corpus-equivalence.test.ts` pins that this copy and that patched npm build
produce identical event streams.

## Pin

- Upstream repo: `marko-js/htmljs-parser`
- Tag: `v5.18.0` (package version `5.18.0`)
- Commit: `05d5789e7986bc78c0cf387034cbcc3323ae560f` (the tag's commit; tag
  object `2da494e1fa4ba5bcc85f47a885ba5baa26d2392c`)
- Commit date: 2026-09-28
- Copied: 2026-10-05, from `git archive v5.18.0` of `data/forks/htmljs-parser`
- Source path: `src/` (`core/`, `states/`, `util/`, `index.ts`, `internal.ts`,
  `__tests__/`)

## Kept

- `core/`, `states/`, `util/`, `index.ts`, `internal.ts`: byte-identical to
  `v5.18.0` except the files listed under "Changes after the copy".
- `__tests__/`: upstream's 418 fixture directories and its `node:test` suite
  (`api`, `escape`, `main`, `validate`; 552 tests), byte-identical, plus
  `base-offset.test.ts` (MX's own, added after the copy). They run under
  `node --test` from `upstream-suite.test.ts`; vitest excludes the
  directory (`vitest.config.ts`) because it cannot collect `node:test` files.

## Dropped

Everything outside `src/`: build (`build.ts`, `tsconfig.build.json`),
`bench.ts`, changesets, lint and format config, the README and CHANGELOG, the
agent docs, `dist/`. `@mxlang/parser`'s own build does not include this
directory yet (nothing imports it).

## Changes after the copy

The decision 146 rule, applied as ordinary source edits. It is the bun patch
`patches/htmljs-parser@5.18.0.patch`, whose hunks edit the built
`dist/index.js` and `dist/index.mjs`; each hunk (identical in both builds) maps
to one place in `src/`:

| Patch hunk (dist) | Source location |
|---|---|
| `ATTRIBUTE` default state: `expr.attrValue = !!(attr.name \|\| attr.spread)` before `expr.operators = !0` | `states/ATTRIBUTE.ts`, where the attribute value `EXPRESSION` is entered (`attr.stage = ATTR_STAGE.VALUE`) |
| `case 63` (`?`): skip `??` and `?.` (not `?.5`) when `expression.attrValue` | `states/EXPRESSION.ts`, `case CODE.QUESTION` of `EXPRESSION.char` |
| `lookAheadForOperator`: `case 58` split out of the pass-through cases; ends the value at ` :ident` (no open `?`) or a bare `:` before `>`, `/>`, newline or EOF | `states/EXPRESSION.ts`, `lookAheadForOperator`, `case CODE.COLON` |
| `lookAheadForOperator`, `case 46`: ` .ident` ends the value | `states/EXPRESSION.ts`, `lookAheadForOperator`, `case CODE.PERIOD` |
| helpers `isBareColonEnd`, `isIdentStartCode` | `states/EXPRESSION.ts`, end of file (plus `isDigitCode`, the inline `>= 48 && <= 57` of the `?.` hunk) |
| (the minified build keeps the flag implicit) | `states/EXPRESSION.ts`: `attrValue: boolean` on `ExpressionMeta`, initialised `false` in `enter` |

Nothing else from the decision 146 rule differs from `v5.18.0`. To check:
extract `git archive v5.18.0 src` of upstream and diff; only
`states/ATTRIBUTE.ts` and `states/EXPRESSION.ts` differ from upstream for that
rule, plus the three files the base-position addition below touches.

## Base position for fragment parses (MX addition, not from the patch)

`docs/upstream/htmljs-parser-offset.patch` is this project's own proposal to
upstream htmljs-parser, never sent. Its design is applied here as ordinary
source, so `core/Parser.ts` and `index.ts` now also differ from `v5.18.0`.
No state file is touched — the change is confined to the two files and one
test file the patch itself names.

`parse(code, options?)` accepts an optional base position
`{ startOffset?, startLine?, startColumn? }` for the case where `code` is a
substring of a larger file, plus a new `offsetAt(offset)` that rebases a raw
character offset the same way. The contract:

- Ranges passed to handlers (including error ranges) and read back by
  `read(range)` stay relative to the string passed to `parse`, exactly as
  without the options; `positionAt`, `locationAt` and `offsetAt` are relative
  to the enclosing file.
- `startColumn` applies to the fragment's first line only; later lines start
  at column 0. `startLine` shifts every line. `startOffset` shifts offsets
  and nothing else. All three default to 0, so an absent or empty options
  object is behaviourally identical to passing none.
- Positions stay in UTF-16 code units, as they are upstream.

Internal indexing is untouched: the substring is still scanned from index 0
(`this.pos`, `this.data`), which is why handler ranges stay
fragment-relative and why a handler that reads a node's own `start`/`end`
back through `locationAt` mid-parse — `@marko/compiler`'s `onCloseTagEnd`
does exactly this — shifts once, not twice.

Covered by `__tests__/base-offset.test.ts`, alongside the upstream suite.

## Tests

- `__tests__/` (upstream, above), via `upstream-suite.test.ts`.
- `mx-after-value.test.ts`: `patches/htmljs-parser.test.ts` re-pointed at this
  source (vitest).
- `corpus-equivalence.test.ts`: event streams of this copy against the patched
  npm build over every tracked `.mx`, `.marko` and `.amx` file and every `mx` /
  `marko` Markdown fence.
- `__tests__/base-offset.test.ts`: the base position — handler ranges
  identical with and without the options, `offsetAt` shifting only by
  `startOffset`, the first-line-only column rule, non-BMP input, zero bases,
  an error at end of input, the mid-parse `locationAt` single-shift case, and
  an embedding-equivalence property test against a whole-document parse.
