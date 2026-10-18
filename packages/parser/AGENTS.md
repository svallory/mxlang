# parser — agent instructions

`packages/parser` holds `src/template/`, the htmljs-parser-derived template
parser and its tests, and `src/frontend/`, the MX2 front end that builds the
MX AST from the template parser's events (PR 2 of the parser port; see
below). It is private and has no build; the entry is `src/template/index.ts`. The Babel fork is `packages/babel` and the bridge is
`packages/tsx-bridge`; neither depends on this package.
`@mxlang/babel` is a devDependency for `src/template/mx-sugar-module.test.ts`,
which checks the atom row's claims against Babel's `parseExpression`, and for the front end's
type-only imports of the MX AST types (`@mxlang/babel/mx-ast`).

Biome **ignores** `src/template/` wholesale
(`packages/parser/src/template/{core,states,util,__tests__}`, plus
`index.ts` and `internal.ts`, in `biome.json`'s `files.includes`), to keep the
vendored copy byte-comparable with upstream. `biome check` on those paths
reports them as ignored and checks nothing, so "lint clean" is vacuous there:
match the repo's formatting by hand or via
`biome format --stdin-file-path=x.ts < <file>`.

`.pi-lens.json` at the repo root exempts `packages/parser/src/template/**` from
pi-lens's SAFETY-comment rule for `as unknown as`, for the same reason: the
directory is copied upstream source kept byte-identical except the two patched
state files and MX's own patches, so the rule asks every editor to change lines
that are outside their task and that upstream owns. The exemption was requested
by the repo's lead, who owns the tooling.

## The syntax table

`src/template/syntax.ts` holds `SyntaxTable` (plain data, no function field),
`DEFAULT_SYNTAX` (the `.mx` row, today's grammar) and `validateSyntaxTable`;
`createParser(handlers, { syntax })` and the front end's `parse(source, {
…, syntax })` take a table (an invalid one is a `TypeError`). Triggers are
armed in three positions (expression, attribute name, tagless concise line),
announced through `onTrigger` and stood in by `read()` at the same length;
the front end builds `MxTrigger` nodes (`@mxlang/babel/mx-ast`, ast §4.4).
With a `claim` option (`createParser(handlers, { syntax, claim })`, the
front end's `parse(source, { …, claim })`; core passes it), a matching
expression, attribute or line row is asked once per position and offset in one parse
attempt (a restart for a missed tag name asks again; core's `parseMx`
memoizes across attempts): `undefined`
declines, and the parse goes on as if no row matched; an object rides on
the trigger event (`Ranges.Trigger.claim`), and the front end places it in
the tree by identity (`freezeCopy` keeps it) in the trigger's place, unless
its type is `MxTrigger`. An expression row is asked from `EXPRESSION`'s
`lexTrigger` (`Parser.claimHit`) once its own checks pass; a claimed node
takes the trigger's place in the container's `triggers`, and Babel still
parses the row's stand-in. A throw out of `claim` leaves `parse` unwrapped
(`ClaimThrow`), not as `MX_FRONT_END_INTERNAL`. The parser has no name
sugars: a colon in a tag head, a spaced ` :b` after a value and a spaced
`#id`/`.class` lex as stock htmljs-parser lexes them, and it has no atom
lexer: `:name` in an expression reads as stock reads it (`<a b=:x/>` is
Babel's "Unexpected token" at the `:`; `::` in a name is part of the name).
Atoms are a dialect feature: a dialect registers an atom node type and names
it from an expression row on its sigil; core lowers the claimed node to the
forward its type's `lower` returns.
`tagShorthands: false` (`@unstable`, default `true`) removes the tag head's
`#id`/`.class` shorthands and the implicit `div`: `states/TAG_NAME.ts` lets a
`.` continue the name (`billing.InvoiceVoided` is one name, concise and HTML,
and the front end's pre-scan `tag-types.ts` agrees), and reports
`MX_NO_TAG_SHORTHAND` (a `#`, or a head starting with `.`/`#`) and
`MX_INVALID_TAG_NAME` (a trailing or doubled `.`, a `.` after a `${…}`) as
template errors named `MX_*` in `error-code.ts`, so `parse.ts` hands them on
unchanged. Tests: `src/template/mx-tag-shorthands.test.ts`,
`src/frontend/tag-shorthands.test.ts`.
`src/template/test-support/sugar-rows.ts` holds layer-2 rows that express the
atoms and the name sugars as a dialect would (test fixtures, run by
`src/template/mx-sugar-module.test.ts` over the corpora of
`src/template/mx-atoms.cases.ts`). Nothing is lowered here.
Block tags and filters (`MxBlockTag`, `MxFilter`, ast §4.5) are raw body
children in HTML content. Tag types come from the table's `tagTypes`, never
from a handler's return: the front end passes `ParseOptions.tagTypes`, or
builds them before the parse by pre-scanning the source with `tagShape`
(`src/frontend/tag-types.ts`, interim until PR C builds them in core),
restarting with any name the scan missed.
`src/template/PROVENANCE.md` lists every place the table touches.

## `src/frontend/` (the MX AST front end)

- `parse(source, { statementKeywords, tagShape, base?, syntax?, tagTypes? })` builds the MX AST
  of `apps/docs/docs/architecture/ast.md` (one handler per row of its §7
  table); `lineColumnAt(document, offset)` gives 1-based line, 0-based column.
- **Exported** as the package's second entry point since PR 3
  (`@mxlang/parser/frontend`: `parse`, `lineColumnAt`, `ParseOptions` and the
  option types re-exported from `@mxlang/babel/mx-ast`; `boundary.test.ts`
  pins both entry points). Containers carry their Babel payload from
  `src/frontend/expressions.ts`, which calls `@mxlang/babel` with Marko's
  fixed configuration and wrappers (ast §7.1).
- It never throws on input: a template-parser error, an internal failure
  (`MX_FRONT_END_INTERNAL`) and a throw out of the template parser itself all
  come back in `errors` with the partial tree. Missing options are a
  `TypeError`.
- `seams.frontEndRules` is where PR 2b's `MX_*` rules run (once per tag);
  `seams.clamped` counts the one clamp for the template parser's
  end-of-input ranges. Tests replace seams and restore them.
- Input that ends inside a concise open delimiter (`div(a`, `div|a`,
  ``x<a x=`${<a>``, `$ {a`, `${x`) gets `MX_INPUT_ENDS_IN_DELIMITER` ("the
  input ends inside `(`…`)` opened here", spanning the outermost opener left
  open), where the template parser and stock htmljs-parser are silent;
  the tags are closed at the end and kept. Pinned in `input-ends.test.ts` and
  the corpus.
- `corpus.test.ts` runs the 1,717 grammar probes and compares each tree's
  projection with `corpus.snapshot.json`. A deliberate change regenerates it:
  `FRONTEND_SNAPSHOT_UPDATE=1 bunx vitest run --root ../.. --project @mxlang/parser frontend/corpus`,
  then `bunx biome format --write src/frontend/corpus.snapshot.json`, and the
  diff is reviewed.
- The long no-throw fuzz is not in the test run:
  `bun run src/frontend/test-support/long-fuzz.ts <seed> <count>` (count of at
  least 500,000 per generator for a report).
- Unlike `src/template/`, `src/frontend/` is linted and format-checked.
