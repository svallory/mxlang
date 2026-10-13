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
| the inline `>= 48 && <= 57` of the `?.` hunk | `states/EXPRESSION.ts`, end of file (`isDigitCode`) |
| (the minified build keeps the flag implicit) | `states/EXPRESSION.ts`: `attrValue: boolean` on `ExpressionMeta`, initialised `false` in `enter` |

Nothing else from the decision 146 rule differs from `v5.18.0`. To check:
extract `git archive v5.18.0 src` of upstream and diff; only
`states/ATTRIBUTE.ts` and `states/EXPRESSION.ts` differ from upstream for that
rule, plus the two files the base-position addition below touches.

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

### Expression positions and the look-behind

The template parser lexes no atom: `:name` in an expression is JavaScript
and reads exactly as stock htmljs-parser reads it (`<a b=:x/>` reaches
Babel as `:x`; `::` in a tag or attribute name is part of the name,
`<a::b/>` is the tag `a::b`). Atoms are a dialect feature: a dialect arms an
expression row on `:` in its syntax table, and the same look-behind that
decides where an operand is expected decides where that row fires. The
patch carries none of this; it is source-only, like the syntax table below.

| Source location | What it does |
|---|---|
| `states/EXPRESSION.ts`: `triggers`, `comments`, `regexEnd` on `ExpressionMeta` | `triggers` arms expression triggers for one expression; the other two let the look-behind skip comments and see a regex end |
| `states/ATTRIBUTE.ts` (value, argument and method-shorthand body `EXPRESSION`; a method body is an attribute value), `states/LINE_TRIGGER.ts`, `states/OPEN_TAG.ts` (tag arguments), `states/PLACEHOLDER.ts` (`checkForPlaceholder`), `states/TAG_NAME.ts` (a `${}` in a tag name or shorthand) | set `triggers = true` |
| `states/TEMPLATE_STRING.ts` | a template's `${}` inherits `triggers` from the template's own expression |
| `states/EXPRESSION.ts`, `return` | records comment and regular-expression children while `triggers` is on |
| `states/EXPRESSION.ts`, end of file | `operandKeywords`, `expectsExpression` |

Behaviour of the look-behind (it is `expectsExpression`; a trigger is lexed
only where it holds, apart from the `?` bypass in `lexTrigger`):

- Triggers are armed only in attribute values (named, default, bound and
  spread), attribute arguments, tag arguments, placeholders (`${}`, `$!{}`),
  method-shorthand bodies (`x(v) { … }`, an attribute value), every `${}` of
  a tag name or shorthand, and the `${}` of a template literal inside one of
  those. Never in statement tags (`static`, `import`, …), scriptlets, tag
  variables, tag parameters or type arguments, and never in string,
  template or regex text or comments (those are other states).
- An operand is expected at the start of the expression, or after an
  operator, a punctuator, a spread's `...` or one of `operandKeywords`
  (`return`, `typeof`, `in`, …). Never after an expression end (a word, a
  literal, `)`, `]`, `}`, a quote, a regex), after `.` or `?.`, after
  `as`/`satisfies`, after a postfix `++`/`--` (a pair after an operand end
  on the same line: `a++`, `n-- :a`; a prefix pair expects an operand, so
  `++&n`, `a + ++%.now` and `typeof --&n` arm), or, for a `:`, as
  TypeScript's optional/definite marker (`x?:`, `x!:`: a `?` or `!` directly
  after a word, `]`, `-` or `+` and directly before the `:`).

`read(range)` returns the source of `range` with every trigger wholly inside
it replaced by its same-length stand-in (`Parser#standIn`, "The syntax table"
below). With no trigger lexed, it is the source: nothing is replaced in a
`.mx` file on the default row.

To check what differs from `v5.18.0`: extract `git archive v5.18.0 src` of
upstream and diff. The files that differ are `index.ts`, `core/Parser.ts`,
`states/ATTRIBUTE.ts`, `states/CLOSE_TAG.ts`, `states/EXPRESSION.ts`,
`states/INLINE_SCRIPT.ts`, `states/JS_COMMENT_LINE.ts`, `states/OPEN_TAG.ts`,
`states/PLACEHOLDER.ts`, `states/TAG_NAME.ts`, `states/TEMPLATE_STRING.ts`,
`util/constants.ts` and `util/util.ts` (`index.ts` from the base position
above, `INLINE_SCRIPT.ts` and `util/util.ts` from the look-behind sections
below, `CLOSE_TAG.ts` and `JS_COMMENT_LINE.ts` from the crash fix below), and
the files the syntax table adds or touches (its own section).

Unicode whitespace in every look-behind (template-parser-lookbehinds-
followup, decision 156 addenda 11 and 12; both dist builds carry the same
JavaScript). Wherever a look-behind asks "is this whitespace", the set of
`isUnicodeSpaceCode` answers as ASCII whitespace does, through the one
`isUnicodeWhitespaceCode`. Each input renders as
its ASCII-space twin (`unicodeWhitespaceTwinMismatches`), except the
addendum 12 pair below.

| Source location | Function | What changed |
|---|---|---|
| `core/Parser.ts` | `getPreviousNonWhitespaceCharCode` | skips Unicode whitespace, so `(é)\u00a0/ 2` divides (`canFollowDivision`) and `(a: T)\u00a0=> a` keeps its type reading |
| `states/EXPRESSION.ts` | `EXPRESSION.char` (the terminator look-behind before `shouldTerminate`; the `{` look-behind in a type) | `lookBehindWhile(isUnicodeWhitespaceCode, …)`: `a +\u00a0` before a terminator continues past the operator |
| `states/EXPRESSION.ts` | `checkForOperators` | looks behind past a run of Unicode whitespace (`isUnicodeSpaceCode` only, never ASCII) right before the whitespace or newline that triggered it (`a +\u00a0 b`, `a +\u00a0\n`) |
| `states/EXPRESSION.ts` | `lookBehindForOperator`, `++`/`--` case | `lookBehindWhile(isUnicodeWhitespaceCode, …)` |
| `states/ATTRIBUTE.ts` | `shouldTerminateHtmlAttrValue` | a Unicode-whitespace-preceded `>=` is a comparison (`<if=count\u00a0>= 10>`) |
| `states/ATTRIBUTE.ts` | `shouldTerminateConciseAttrValue`, `shouldTerminateConciseAttrName` | a Unicode-whitespace-preceded `--` starts the text block (addendum 12: the attribute's range keeps the trailing whitespace, `1\u00a0` or `x\u00a0`, because an ASCII space ends the attribute by the current-character test, which is unchanged; pinned in `CONCISE_DASH_ROWS`) |
| `states/HTML_CONTENT.ts` | `HTML_CONTENT.parse` | none: addendum 11 is withdrawn here (addendum 13, item 1). Only ASCII whitespace before `//` or `/*` in HTML text starts a comment, as upstream; `<p>Visit\u00a0//cdn.example/x.js</p>` is text. The function is byte-identical to upstream again |

Comments around an operator word (same follow-up; source only): `isOperatorWord`'s
look-back before `of`, `yield` and `await` steps over comments
(`expression.comments`) as `expectsExpression` already does, so under a `:`
expression row `f(/*c*/ await :b)` reads as `f( await :b)` and
`(a /*c*/ of :b)` as `(a  of :b)` (`commentTwinMismatches`). The terminator
look-behind does not step over comments: `x=c ? /*c*/ of :b` still splits
at the whitespace after the comment (a separate site, not changed).

Left: every current-character and look-ahead whitespace test (a value
still does not end at a Unicode space; the `.` look-aheads), and `detectAmbiguousCloseAngleBracket`'s look-behinds, which a
forward scan reaches only after it has rejected a Unicode space.

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
| `util/util.ts` | `htmlEOF` | a tag that never got its name (`<,>a`, `<,>`) and is still open at the end of the input reports `MISSING_END_TAG` named as the default `div` (as `ensureExpectedCloseTag` names it; only when the tag has no name range, an empty name such as `<#i>` keeps `""`) instead of reading the range of a name it never had, which threw a `TypeError` out of `parse()` (decision 156 addendum 13, item 5; both dist builds carry the same JavaScript) |

`JS_COMMENT_BLOCK` runs no close-tag check. `checkForClosingTag`'s only
other caller, `PARSED_TEXT_CONTENT`, is the text body itself. Tests:
`mx-no-throw.cases.ts` (20 rows and a seeded fuzz of 5,000 inputs; seed 1
passes) and a line-shaped fuzz (`fuzzLineThrows`, seed 1, 5,000 inputs).
A 500,000-input sweep (token seeds 1 to 50 and line seeds 1001 to 1050,
5,000 each) throws 0 times on this copy and both dist builds.

## The syntax table (decision 182)

MX's own, not in the patched npm build: `createParser(handlers, { syntax })`
reads a `SyntaxTable` (`syntax.ts`, plain data, validated and compiled once
per table object). `DEFAULT_SYNTAX`, the default, compiles to no trigger
sets, so every check below is one `null` test and the event stream is the
npm build's (`corpus-equivalence.test.ts` still pins that). The parser has
no built-in atoms and no built-in name sugars: `:x` in an expression, a
spaced ` :b`, ` .b` or bare ` :` after a value, and `::` in a name read as
stock reads them. A dialect expresses atoms and the name sugars as rows
(`test-support/sugar-rows.ts` holds the fixtures).

| Source location | What changed |
|---|---|
| `syntax.ts` (new) | `SyntaxTable`, `Trigger`, `DEFAULT_SYNTAX`, `validateSyntaxTable`, `compileSyntax` (per-list 128-entry first-character table plus a non-ASCII list, sticky `u` matchers), `matchTrigger`, `standInText`. `Trigger.value?: "refuse"` (attribute triggers only, validated as `terminatesValue` is; `CompiledTrigger.refusesValue`) |
| `core/Parser.ts` | `syntax` (compiled table, a constructor argument), `triggers` and `lastTriggerStart`; `recordTrigger`; `read` goes through `standIn` when a trigger was lexed, which replaces each trigger wholly inside the range by its same-length stand-in (binary search for the first candidate; a read of exactly a raw open tag, `rawOpenTags`, returns the source) |
| `index.ts` | `createParser`'s second argument; exports `DEFAULT_SYNTAX`, `validateSyntaxTable` and the table types |
| `util/constants.ts` | `onTrigger` and `Ranges.Trigger` (slice a1: `method`, an attribute trigger's method value) |
| `states/EXPRESSION.ts` | `lexTrigger`, before the word fast path in expressions that arm triggers (`ExpressionMeta.triggers`), where `expectsExpression` holds or right after a ternary's `?` (never inside a word, never continuing a punctuator of the same character), and refused with an error when the text after the match would continue the stand-in's token (`continuesToken`); a trigger's end is recorded in `atomEnd` (its text is an operand, never a keyword); `checkForOperators` ends an attribute value at a space then a `terminatesValue` attribute trigger under `valueMayEndAt`, the decision 146 guard (`attrValue` or a default value a value row claims whole, no open `?`); the EOF message of a trigger value. Slice a1: P1, the `?` bypass never applies to a trigger armed on `:` (TypeScript's optional marker is `?` then `:`, `a?:T`, `a? :T`), so there `expectsExpression` alone decides; P2, a trigger whose next text would continue its token declines silently, by `continuesToken` or `stopsShortOfToken` (the matcher would take more had the non-ASCII word characters after it been ASCII letters: `:a-é`) |
| `states/ATTRIBUTE.ts`, `states/attr-stage.ts` | `lexAttrTrigger` at a name's first character, an optional `=value` with whitespace before `=` as after a name (stage `TRIGGER_VALUE`), `endsAttrTriggerAt`; the value-entry code factored into `enterAttrValue`, used by both. A method value after a trigger (`(params) { body }`, `<T>(…) { … }`, `async` before the trigger), lexed by the attribute's own `(` / `<` / `{` branches (no empty name is announced) and announced as the trigger's `method`; `(args)` without a body are the trigger's `args` (review 460 r1, L1: core refuses them through the hook), lexed as a named attribute's arguments, after which `=` / `:=` may give a value and `exit` announces a trigger not yet announced; `:=` after a non-refusing trigger is a value lexed as for `=`, announced with `operator: ":="` (`"="` for `=`, also on line triggers); the generic follow error lists "a method" for a non-refusing row; `isAsyncMethodPrefix` holds `async` before a trigger until the body shows. `value: "refuse"`: `=`, `:=` or `(` after the trigger (after whitespace) is ``The `#main` shorthand takes no value.``, `INVALID_ATTRIBUTE_VALUE`, positioned at that operator; like every parser error it ends the parse (`emitError`), so nothing cascades. `enterAttrValue` sets `claimDefault` for a default `=value` when the table has value rows |
| `states/CONCISE_HTML_CONTENT.ts`, `states/LINE_TRIGGER.ts` (new), `states/index.ts` | a line trigger at a tagless concise line start, its optional `=value` (a concise attribute value, spaces allowed before `=`), then whitespace or a `//` / block comment (reported through `onComment`, as after a concise tag line) |
| `states/BLOCK_TAG.ts` (new), `states/HTML_CONTENT.ts`, `states/index.ts` | PR B: a table's block tag (`open`, raw body, first `close`) and filter (`open`, a name, `close`, raw body, next `close`) in HTML content, announced by `onBlockTag` / `onFilter`; the text run stops at their first characters (`contentStops`, empty on the default row); an unclosed one is `MALFORMED_BLOCK_TAG` / `MALFORMED_FILTER` (new codes 31, 32, `util/error-code.ts`) at end of input; an opener at a concise line start is `INVALID_LINE_START` (`states/CONCISE_HTML_CONTENT.ts`) |
| `states/TAG_NAME.ts` | PR B: `tableTagType`, the table's `tagTypes` keyed by the full written static name (decision 182 addenda 2 and 3): dynamic and `@` names never looked up, absent is html, `statement` only on a concise line; a type an `onOpenTagName` handler still returns wins (the bundled `@marko/compiler` path, whose table is empty) |
| `__tests__/base-offset.test.ts` | `onTrigger`, `onBlockTag`, `onFilter` are table-only handlers: declared, never fired by either default-row source |

## Tests

- `__tests__/` (upstream, above), via `upstream-suite.test.ts`.
- `mx-after-value.test.ts`: `patches/htmljs-parser.test.ts` re-pointed at this
  source (vitest).
- `mx-atoms.cases.ts`: the atom row's corpora (`ATOMS`, `NOT_ATOMS`,
  `SUGAR_FORMS`, the generated suites); run through the `:` expression row by
  `mx-sugar-module.test.ts`. `patches/htmljs-parser.test.ts` runs the same
  inputs against both npm builds and the default row and asserts they read
  as stock reads them, with no atom lexed.
- `mx-triggers.test.ts`: the syntax table: the `&` member row in all three
  positions, other trigger shapes, `terminatesValue`, `read()` through
  stand-ins, one negative case per validation rule, and the default row's
  event-stream parity over the grammar corpus; slice a1's `value: "refuse"`,
  method values after an attribute trigger, P1 and P2.
- `mx-block-tags.test.ts`: block tags, filters and `tagTypes` (PR B), and
  their validation.
- `mx-sugar-module.test.ts`: atoms as a dialect builds them. The atom
  corpora of `mx-atoms.cases.ts` (and its generated suites) run through the
  atom row of `test-support/sugar-rows.ts` (`ATOMS_SYNTAX`), its triggers
  rendered as plain events by `test-support/sugar-module.ts`, and the
  default row reads the same inputs as stock Marko does.
- `corpus-equivalence.test.ts`: event streams of this copy against the patched
  npm build over every tracked `.mx`, `.marko` and `.amx` file and every `mx` /
  `marko` Markdown fence.
- `__tests__/base-offset.test.ts`: the base position — handler ranges
  identical with and without the options, `offsetAt` shifting only by
  `startOffset`, the first-line-only column rule, non-BMP input, zero bases,
  an error at end of input, the mid-parse `locationAt` single-shift case, and
  an embedding-equivalence property test against a whole-document parse.

Look-behind rules of `expectsExpression` (source only; the patch does not
carry them):

- **Markers and operand ends.** A `?` right after a word or `]` is
  TypeScript's optional marker and a `!` right after an operand is postfix,
  whitespace before the `:` or not; a type's closing `>` (`inType`, not `=>`)
  ends an operand, as does a type argument list's closing `>`
  (`closesTypeArguments`: the matching `<` written right after a word, in
  the same group) and a run of postfix `!` (`a!!`, `a! !`), at every depth
  (groups, placeholders, tag arguments, method bodies). A number before `?`
  is never TypeScript's optional marker. `of` is an operator only after an
  operand, `yield`/`await` not after `?`, `:`, `,` or `(` (`isOperatorWord`).
  A word after a spread's `...` is an operator, not a member name
  (`isSpreadEnd`: `[...await :b]` under a `:` row).
- **A trigger that would continue its token declines.** A non-ASCII letter
  right after a `:` name (`:aé`, `:a-é`) leaves the text as source
  (`continuesToken`, `stopsShortOfToken`), so no stand-in reaches Babel's
  message.
- **`read()`** binary-searches the first trigger at or after the range start.
  Reading exactly a trigger's own range returns its stand-in, by design: that
  is how a trigger's value reaches Babel. A read of exactly the raw open tag
  (`rawOpenTags`: tag-name start to open-tag-end start, which
  `@marko/compiler` builds `rawValue` from and `<style>` uses) returns the
  source, while a mixed tag name's template (`<foo-${&a}>`) reads its
  stand-ins. `read()`'s consumers in `@marko/compiler` parse expressions from
  value, argument, placeholder and method ranges (stand-ins wanted) and slice
  the raw open tag (source wanted).
- **Every `${}` is an expression position.** Tag names and shorthands
  (`states/TAG_NAME.ts`) arm triggers too, as do placeholders in
  `<script>`/`<style>`/`<textarea>` bodies.

Non-ASCII look-behind (source only):

- **A non-ASCII character is a word character behind a `:`.** The
  look-behind (`expectsExpression`, `isOperatorWord`, `closesTypeArguments`)
  classifies characters with `isUnicodeWordCode` (`util/util.ts`): `isWordCode`,
  or, as "The exact word class" below defines it, a
  code point at or above U+0080 that is `ID_Continue` or U+200C or U+200D. So
  under a `:` expression row `{ é:a }`, `(é :T) => é` and `c ? é :z` keep
  TypeScript's colon, `éin`/`éof`/`étypeof` are names rather than operator
  words, and `(é of :b)` lexes the trigger, exactly as the same input with an
  ASCII letter (`asciiTwinMismatches` pins the equivalence). The characters
  that are ECMAScript WhiteSpace or LineTerminator above ASCII, which is also
  Babel's set (U+00A0, U+1680, U+2000
  to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF) are not word
  characters: TypeScript cannot own a `:` after one, so `[a,\u00a0:b]` keeps
  its trigger. The look-behind's whitespace loops (`expectsExpression`, its
  `!` case, `isOperatorWord`) skip them as whitespace too
  (`isUnicodeWhitespaceCode` in `util/util.ts`: `isWhitespaceCode` or
  `isUnicodeSpaceCode`), so each behaves exactly as an ASCII space
  (`unicodeWhitespaceMismatches`, `unicodeWhitespaceLoopMismatches`):
  `{ é\u00a0:a }` is a key, and `(a?\u00a0:b : c)` and `(Array<T>\u00a0:b)`
  read as their ASCII-space spellings (`divergences.md`). Nowhere else in the
  template grammar does a non-ASCII space change meaning.
  `isWordCode` itself stays ASCII. U+0085 and U+200B, which TypeScript
  also skips, are not in the set: ECMAScript and Babel reject both.

Non-ASCII identifiers outside the trigger look-behind (template-parser-ascii-only-
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
| `states/EXPRESSION.ts` | `canFollowDivision` | (receives a code point from `getPreviousNonWhitespaceCharCode`) a `/` after a non-ASCII identifier is division (`x=é / 2`, `${é / 2}`), not a regular expression |
| `states/EXPRESSION.ts` | `isWordOrPeriodBefore` (`lookBehindForKeyword`; `isWordOrPeriodCode` until addendum 13) | a name ending in a unary or relational keyword after a non-ASCII letter is no keyword (`x=énew y=1` no longer swallows `y=1`) |
| `states/EXPRESSION.ts` | `lookBehindForOperator`, `case CODE.EXCLAMATION` | a `!` after a non-ASCII identifier is postfix (`x=é! y=1`) |
| `states/EXPRESSION.ts` | `lookBehindForOperator`, `case CODE.PERIOD` | a `.` before a non-ASCII identifier continues the member access (`x=a. é`, `x=a.\n  é`) |
| `states/EXPRESSION.ts` | `lookAheadForOperator`, `case CODE.PERIOD` | the same, looking ahead (`<if=a .é>`, `x=a . é`) |
| `states/ATTRIBUTE.ts` | `detectAmbiguousCloseAngleBracket`, `isOperandEndAt` (`isOperandEndCode` until addendum 13) | a non-ASCII operand counts, so `<div x=a >é>c</div>` reports the ambiguous `>` |
| `states/ATTRIBUTE.ts` | `isAsyncMethodPrefix` | a non-ASCII method name after `async` (`<div async é() {…}>`) |
| `states/INLINE_SCRIPT.ts` | `startsTypeName` | a non-ASCII type alias name (`$ type é = …`), and a name starting with a binary keyword (`type iné`) |

The exact word class (decision 156 addendum 13, item 2; both dist builds
carry the same JavaScript). `isUnicodeWordCode(code)` takes a code point:
below U+0080 it is `isWordCode` (the ASCII test stays a comparison); at or
above, U+200C and U+200D, and otherwise `\p{ID_Continue}` (one module-level
regex, run only for a non-ASCII code point, never built per call), and a lone
surrogate is none. A surrogate pair is read as one code point by two
position-aware helpers in `util/util.ts`, `wordWidthBefore(data, i)` (the
character ending at `i`: a low surrogate is combined with the high surrogate
before it) and `wordWidthAt(data, i)` (the character starting at `i`), which
return its width in UTF-16 units, 0 for none; every site above that took
`data.charCodeAt(…)` now asks one of them. The loops that step back over a
word (`wordStartOf`, used by `isOperatorWord` and the `?` case of
`expectsExpression`, both source only) and the forward scan of `detectAmbiguousCloseAngleBracket`
step by that width. `getPreviousNonWhitespaceCharCode` returns a code point
(its two callers compare it with ASCII codes or pass it to `canFollowDivision`).
Before, every code unit at or above U+0080 except the 19 Unicode whitespace and
line terminator characters counted, about 950,000 code points that are no
identifier character (©, ×, …, «, emoji); that broke
`<div x=a >©>c</div>`, which parses in stock htmljs-parser and compiles in
Marko 6.3.51.

Left ASCII, on purpose: the expression fast path (`if (isWordCode(code))`
in `EXPRESSION.char`: a non-ASCII character falls through to the same
result, more slowly), the keyword checks that test a
lowercase ASCII first or last letter (`lookBehindForOperator`'s default case,
`lookAheadForOperator`'s), `isWhitespaceCode` everywhere outside the
look-behind, and `isIndentCode`.
