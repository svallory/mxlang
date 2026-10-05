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

## Base position for fragment parses

`docs/upstream/htmljs-parser-offset.patch` is this project's own proposal to
upstream htmljs-parser, never sent. Its design is applied here verbatim, as
ordinary source, so `core/Parser.ts` and `index.ts` now also differ from
`v5.18.0`. It was applied by editing this copy directly rather than by running
`git apply`: the patch's non-test hunks landed unchanged, and its test hunk —
which edits `__tests__/api.test.ts`, upstream's own byte-identical file — was
replaced by a new `__tests__/base-offset.test.ts` so that upstream's suite and
its snapshots stay untouched. No state file is touched: the change is confined
to the two source files the patch names.

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

### Atoms (decision 156)

Atom lexing, the same change as the patch's atom hunks (both dist builds carry
identical JavaScript for it):

| Source location | What it does |
|---|---|
| `states/EXPRESSION.ts`: `atoms`, `comments`, `regexEnd` on `ExpressionMeta` | `atoms` turns lexing on for one expression; the other two let the look-behind skip comments and see a regex end |
| `states/EXPRESSION.ts`, `case CODE.COLON`, first | `lexAtom` runs before the ternary/type handling, so an atom's `:` never counts as a ternary's |
| `states/EXPRESSION.ts`, `return` | records comment and regular-expression children while `atoms` is on |
| `states/EXPRESSION.ts`, end of file | `atomKeywords`, `lexAtom`, `atomNameEnd`, `expectsExpression` |
| `states/ATTRIBUTE.ts` (value, argument and method-shorthand body `EXPRESSION`; a method body is an attribute value, lead ruling 2026-10-05), `states/OPEN_TAG.ts` (tag arguments), `states/PLACEHOLDER.ts` (`checkForPlaceholder`) | set `atoms = true` |
| `states/TEMPLATE_STRING.ts` | a template's `${}` inherits `atoms` from the template's own expression |
| `core/Parser.ts` | `atoms` (reset by `parse`), `read()` stands atoms in, `standInAtoms` |
| `util/constants.ts` | the `onAtom` handler |

Behaviour:

- Atoms are lexed only in attribute values (named, default, bound and spread),
  attribute arguments, tag arguments, placeholders (`${}`, `$!{}`),
  method-shorthand bodies (`x(v) { … }`, an attribute value; lead ruling
  2026-10-05) and the `${}` of a template literal inside one of those. Never
  in statement tags (`static`, `import`, …), scriptlets, tag variables, tag
  parameters or type arguments, and never in string, template or regex text
  or comments (those are other states).
- A `:` starts an atom only where an expression is expected: at the start of
  the expression, or after an operator, a punctuator, a spread's `...` or one
  of `atomKeywords` (`return`, `typeof`, `in`, …). Never after an expression
  end (a word, a literal, `)`, `]`, `}`, a quote, a regex), after `.` or `?.`,
  after `as`/`satisfies`, after a postfix `++`/`--`, or as TypeScript's
  optional/definite marker (`x?:`, `x!:`: a `?` or `!` directly after a word,
  `]`, `-` or `+` and directly before the `:`). The name is
  `[A-Za-z_$][\w$]*(-[\w$]+)*`.
- The ternary counter skips an atom's `:`, so `x=a ? :b :c` is one value;
  that is the only input whose decision 146 split changes.
- `::` (with or without a name) is reserved: `onError` with
  `INVALID_EXPRESSION`, the range of the `::name` token, and "`` `::a` is
  reserved (decision 156): `::` will be the Symbol.for sugar; write `:a` for
  an atom``". Parsing stops there, as for every other parser error.

API (what core and other consumers use):

- `read(range)` returns the source of `range` with every atom wholly inside
  it replaced by a **same-length numeric stand-in**: `0.` followed by zeros
  (`:a` → `0.`, `:rename-all` → `0.000000000`). Babel parses it as a
  `NumericLiteral` at the atom's exact offsets; it is not assignable, not a
  binding and not a shorthand key, so misuse fails at the atom. A consumer
  tells a stand-in from an authored number by the source character at the
  node's start, which is `:` (no authored numeric literal starts with `:`).
  This is how core sees atoms through `@marko/compiler`, which owns the parser
  instance and its handlers.
- `onAtom(range)` (handler, `Ranges.Value`): fired once per atom as it is
  lexed, in source order. `start`/`end` cover the whole atom, `:` included;
  `value` is the name (`start + 1` to `end`). For consumers that drive the
  parser themselves (probes, scans).
- `Parser#atoms` (internal): the recorded spans, `{ start, end }[]`.

An unconverted stand-in reads as a number: anything that compiles through this
parser without core's conversion turns atoms into numbers silently.

Nothing else differs from `v5.18.0`. To check: extract `git archive v5.18.0 src`
of upstream and diff; only `states/ATTRIBUTE.ts`, `states/EXPRESSION.ts`,
`states/OPEN_TAG.ts`, `states/PLACEHOLDER.ts`, `states/TEMPLATE_STRING.ts`,
`core/Parser.ts` and `util/constants.ts` differ.

## Tests

- `__tests__/` (upstream, above), via `upstream-suite.test.ts`.
- `mx-after-value.test.ts`: `patches/htmljs-parser.test.ts` re-pointed at this
  source (vitest).
- `mx-atoms.test.ts`: atom lexing, from the case table in `mx-atoms.cases.ts`,
  which `patches/htmljs-parser.test.ts` runs against both npm builds too.
- `corpus-equivalence.test.ts`: event streams of this copy against the patched
  npm build over every tracked `.mx`, `.marko` and `.amx` file and every `mx` /
  `marko` Markdown fence (`onAtom` included); and that the only atoms in that
  corpus are the atoms ADR's own examples.
- `__tests__/base-offset.test.ts`: the base position — handler ranges
  identical with and without the options, `offsetAt` shifting only by
  `startOffset`, the first-line-only column rule, non-BMP input, zero bases,
  an error at end of input, the mid-parse `locationAt` single-shift case, and
  an embedding-equivalence property test against a whole-document parse.
