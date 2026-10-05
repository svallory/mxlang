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
  `v5.18.0` except the two files below.
- `__tests__/`: upstream's 418 fixture directories and its `node:test` suite
  (`api`, `escape`, `main`, `validate`; 552 tests), byte-identical. They run
  under `node --test` from `upstream-suite.test.ts`; vitest excludes the
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

Nothing else differs from `v5.18.0`. To check: extract `git archive v5.18.0 src`
of upstream and diff; only `states/ATTRIBUTE.ts` and `states/EXPRESSION.ts`
differ.

## Tests

- `__tests__/` (upstream, above), via `upstream-suite.test.ts`.
- `mx-after-value.test.ts`: `patches/htmljs-parser.test.ts` re-pointed at this
  source (vitest).
- `corpus-equivalence.test.ts`: event streams of this copy against the patched
  npm build over every tracked `.mx`, `.marko` and `.amx` file and every `mx` /
  `marko` Markdown fence.
