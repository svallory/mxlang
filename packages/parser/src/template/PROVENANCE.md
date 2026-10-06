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
| `states/EXPRESSION.ts`, end of file | `atomKeywords`, `lexAtom`, `atomNameEnd`, `expectsExpression`, `isLookBehindWordCode` |
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
of upstream and diff; only `index.ts`, `core/Parser.ts`,
`states/ATTRIBUTE.ts`, `states/CLOSE_TAG.ts`, `states/EXPRESSION.ts`,
`states/INLINE_SCRIPT.ts`, `states/JS_COMMENT_LINE.ts`, `states/OPEN_TAG.ts`,
`states/PLACEHOLDER.ts`, `states/TAG_NAME.ts`, `states/TEMPLATE_STRING.ts`,
`util/constants.ts` and `util/util.ts` differ (`index.ts` from the base
position above, `TAG_NAME.ts` from review round 4, `INLINE_SCRIPT.ts` and
`util/util.ts` from template-parser-ascii-only-lookbehinds, `CLOSE_TAG.ts`
and `JS_COMMENT_LINE.ts` from the crash fix below; checked against
`git archive v5.18.0 src`).

## The parser never throws

Rule (mx-lead, template-parser-comment-in-text-tag-open-crash): the
template parser never throws; any internal failure is an `onError`. Stock
5.18.0 threw on a `//` comment inside a text tag's open tag
(`<script x=1 // </script>\n>a</script>`): the comment ran the body's
close-tag check, emitted `</script>` inside the open tag, and a later check
destructured a missing active tag. Both dist builds carry the same
JavaScript.

| Source location | Function | What changed |
|---|---|---|
| `states/JS_COMMENT_LINE.ts` | `JS_COMMENT_LINE.parse`, new `isInTextBody` | the close-tag check runs only for a comment in the text tag's body (`PARSED_TEXT_CONTENT` before any `OPEN_TAG` among its ancestors); a body comment, including one in a body placeholder, closes the tag as before |
| `states/CLOSE_TAG.ts` | `checkForClosingTag` | returns false when there is no active tag |
| `states/CLOSE_TAG.ts` | `ensureExpectedCloseTag` | an active tag that never got its name (`,--/</e>`: the `,` opens one, a concise `--` line follows) cannot match a named closing tag: `EXTRA_CLOSING_TAG`, as with no open tag, instead of reading `tagName.end` and throwing; `</>` still closes it (template-parser-lookbehinds-followup) |

`JS_COMMENT_BLOCK` runs no close-tag check. `checkForClosingTag`'s only
other caller, `PARSED_TEXT_CONTENT`, is the text body itself. Tests:
`mx-no-throw.cases.ts` (20 rows and a seeded fuzz of 5,000 inputs; seed 1
passes) and a line-shaped fuzz (`fuzzLineThrows`, seed 1, 5,000 inputs).
A 500,000-input sweep (token seeds 1 to 50 and line seeds 1001 to 1050,
5,000 each) throws 0 times on this copy and both dist builds.

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

Review round 4 on PR #342 (both dist builds carry the same JavaScript):

- **Look-behind.** A `?` right after a word or `]` is TypeScript's optional
  marker and a `!` right after an operand is postfix, whitespace before the
  `:` or not; a type's closing `>` (`inType`, not `=>`) ends an operand. `of`
  is an operator only after an operand, `yield`/`await` not after `?`, `:`,
  `,` or `(` (`isOperatorWord`). A non-ASCII letter right after a name ends
  no atom (`:aé` stays source, so no stand-in reaches Babel's message).
- **`read()`** binary-searches the first atom at or after the range start
  (it was a linear scan: 627 ms at 40k atoms). Reading exactly an atom's own
  range returns its stand-in, by design: that is how `x=:a`'s value reaches
  Babel. A read of exactly the raw open tag (`rawOpenTags`: tag-name start
  to open-tag-end start, which `@marko/compiler` builds `rawValue` from and
  `<style>` uses) returns the source; round 5 narrowed this from "any read
  starting at a tag name", which also left a mixed tag name's template
  (`<foo-${:a}>`) unconverted. `read()`'s consumers in `@marko/compiler` parse expressions from
  value, argument, placeholder and method ranges (stand-ins wanted) and slice
  the raw open tag (source wanted).
- **Decision 156 addendum 2.** Every `${}` is an expression position: tag
  names and shorthands (`states/TAG_NAME.ts`) lex atoms too, as do
  placeholders in `<script>`/`<style>`/`<textarea>` bodies. `::` in a tag
  name or an attribute name is the reserved-token error, positioned at the
  `::` (`rejectReservedName`, from `TAG_NAME.ts` and `ATTRIBUTE.ts`).

Review round 5 on PR #342 (both dist builds carry the same JavaScript):

- **`::` check is local.** `rejectReservedName` reads only the name's own
  range, one character past each `:`; it used `indexOf` to the end of the
  file, which made every parse quadratic. Tag names and shorthands check
  their static quasis only, so `<${"a::b"}>` is legal and `<div.a::b>` is
  reserved (decision 156 addendum 3).
- **Look-behind at every depth.** A type argument list's closing `>`
  (`closesTypeArguments`: the matching `<` written right after a word, in
  the same group) and a run of postfix `!` (`a!!`, `a! !`) end an operand
  inside groups, placeholders, tag arguments and method bodies too; the old
  rule relied on `inType`, which only a top-level value sets. A number
  before `?` is never TypeScript's optional marker (`n === 1? :a : :b`).
  `:a-é` is no atom, like `:aé`.

Non-ASCII look-behind (atom-lookbehind-non-ascii, decision 156 addenda 2
and 8; both dist builds carry the same JavaScript):

- **A non-ASCII character is a word character behind a `:`.** The
  look-behind (`expectsExpression`, `isOperatorWord`, `closesTypeArguments`)
  classifies characters with `isUnicodeWordCode` (`util/util.ts`; named
  `isLookBehindWordCode` until the next section): `isWordCode`, or any
  code unit at or above U+0080 except Unicode whitespace
  (`isUnicodeSpaceCode`), as `lexAtom` already treats a non-ASCII character
  after a name. So `{ é:a }`, `(é :T) => é` and `c ? é :z` keep
  TypeScript's colon, `éin`/`éof`/`étypeof` are names rather than operator
  words, and `(é of :b)` lexes the atom, exactly as the same input with an
  ASCII letter (`asciiTwinMismatches` pins the equivalence). The characters
  TypeScript reads as whitespace or line terminators (U+00A0, U+1680, U+2000
  to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF) are not word
  characters: TypeScript cannot own a `:` after one, so `[a,\u00a0:b]` keeps
  its atom. Since decision 156 addendum 10 (template-parser-ascii-only-
  lookbehinds) the look-behind's whitespace loops (`expectsExpression`, its
  `!` case, `isOperatorWord`) skip them as whitespace too (`isSpaceCode`:
  `isWhitespaceCode` or `isUnicodeSpaceCode`), so each behaves exactly as an
  ASCII space (`unicodeWhitespaceMismatches`,
  `unicodeWhitespaceLoopMismatches`): `{ é\u00a0:a }` is a key, and
  `(a?\u00a0:b : c)` and `(Array<T>\u00a0:b)` read as their ASCII-space
  spellings (`divergences.md`). Nowhere else in the template grammar does a
  non-ASCII space change meaning.
  `isWordCode` itself stays ASCII. U+0085 and U+200B, which TypeScript
  also skips, are not in the set: Babel rejects both.

Non-ASCII identifiers outside the atom path (template-parser-ascii-only-
lookbehinds, decision 156 addendum 9; both dist builds carry the same
JavaScript). Code that was byte-identical to `v5.18.0` until then looked
behind or ahead with the ASCII-only `isWordCode`, so a non-ASCII identifier
read as punctuation. Every site below now uses `isUnicodeWordCode`, moved to
`util/util.ts` with `isUnicodeSpaceCode` (one definition; the dist builds
define both after `isWordCode`). Each non-ASCII input renders as its ASCII
twin (`mx-unicode-words.cases.ts`), and ASCII-only input renders as before
(`mx-unicode-words.main.json`, recorded from `4bafe5983`).

| Source location | Function | What changed |
|---|---|---|
| `states/EXPRESSION.ts` | `canFollowDivision` | a `/` after a non-ASCII identifier is division (`x=é / 2`, `${é / 2}`), not a regular expression |
| `states/EXPRESSION.ts` | `isWordOrPeriodCode` (`lookBehindForKeyword`) | a name ending in a unary or relational keyword after a non-ASCII letter is no keyword (`x=énew y=1` no longer swallows `y=1`) |
| `states/EXPRESSION.ts` | `lookBehindForOperator`, `case CODE.EXCLAMATION` | a `!` after a non-ASCII identifier is postfix (`x=é! y=1`) |
| `states/EXPRESSION.ts` | `lookBehindForOperator`, `case CODE.PERIOD` | a `.` before a non-ASCII identifier continues the member access (`x=a. é`, `x=a.\n  é`) |
| `states/EXPRESSION.ts` | `lookAheadForOperator`, `case CODE.PERIOD` | the same, looking ahead (`<if=a .é>`, `x=a . é`); the decision 146 ` .name` sugar test uses the new `isNameStartCode` (a word character other than a digit), so `x=a .é` stays sugar |
| `states/ATTRIBUTE.ts` | `detectAmbiguousCloseAngleBracket`, `isOperandEndCode` | a non-ASCII operand counts, so `<div x=a >é>c</div>` reports the ambiguous `>` |
| `states/ATTRIBUTE.ts` | `isAsyncMethodPrefix` | a non-ASCII method name after `async` (`<div async é() {…}>`) |
| `states/INLINE_SCRIPT.ts` | `startsTypeName` | a non-ASCII type alias name (`$ type é = …`), and a name starting with a binary keyword (`type iné`) |

Left ASCII, on purpose: the expression fast path (`if (isWordCode(code))`
in `EXPRESSION.char`: a non-ASCII character falls through to the same
result, more slowly), `atomNameEnd`/`isIdentStartCode` (atom names are ASCII
by decision; `x=a :é` is not split as sugar), the keyword checks that test a
lowercase ASCII first or last letter (`lookBehindForOperator`'s default case,
`lookAheadForOperator`'s), `isWhitespaceCode` everywhere outside the atom
look-behind, and `isIndentCode`.

Same change, two MX-only fixes: `rejectReservedName` ends the name after
`::` at the static piece's end (`<a::b${x}>` reports `::b`, not `::b$`), and
`isOperatorWord` reads a word after a spread's `...` as an operator, not a
member name (`isSpreadEnd`: `[...await :b]` lexes the atom, decision 156
addendum 8).
