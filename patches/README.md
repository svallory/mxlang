# patches

Bun `patchedDependencies` (root `package.json`). `bun install` applies them; `bun.lock` records them.

## `htmljs-parser@5.18.0.patch`

Inside a named attribute's value, `??` and `?.` do not count as an open ternary, so a later `:` is not taken as its colon. A spaced ` :b` or ` .b` after a value continues the value, exactly as in stock.

The patch edits both published builds (`dist/index.js`, `dist/index.mjs`). Tests: `patches/htmljs-parser.test.ts` (vitest project `patches`). It also changes how stock Marko in `packages/oracle` parses the same input.

The patch lexes no atom: `:name` in an expression reads as stock htmljs-parser reads it, `read()` returns the source, and `::` in a name is part of the name. It carries no syntax table or trigger either; those are only in the source copy `packages/parser/src/template/`, whose `PROVENANCE.md` lists every place the copy differs from upstream. Atoms are a dialect feature (a row of a dialect's syntax table), not a parser one.

**Lockstep with the source copy.** Nothing generates one from the other: the copy's TypeScript and the patch's JavaScript are edited by hand to the same logic (the patch's helpers are the copy's, transpiled by hand in esbuild's style), and three tests hold them together: `corpus-equivalence.test.ts` (identical event streams over the repo corpus), the no-atom check in `htmljs-parser.test.ts` (every input of the atom row's corpora in `mx-atoms.cases.ts` reads the same through both builds and the source copy's default row, with no atom event and `read()` returning the source), and the decision 146 tables (`mx-after-value.test.ts` here is `htmljs-parser.test.ts` re-pointed). Change both in one commit.

To regenerate on a version bump (or to change the rule), in this order (`bun install` aborts while `patchedDependencies` points at a missing file):

1. `TMP=$(mktemp -d) && git show HEAD:patches/htmljs-parser@<old>.patch > "$TMP/old.patch"`
2. Delete the `patchedDependencies` entry from the root `package.json` (don't bump it) and `git rm` the old patch file.
3. Bump the version, then `bun install`.
4. `bun patch htmljs-parser@<new>`, then inside the printed folder `patch -p1 < "$TMP/old.patch"` (fix rejects by hand; it edits both dist files).
5. `bun patch --commit 'node_modules/htmljs-parser'` (re-adds the entry), then `bunx vitest run --project patches`.

To change the rule without a version bump: `bun patch htmljs-parser@<ver>` (the printed `node_modules/htmljs-parser` already has the current patch applied), edit both dist files, `bun patch --commit 'node_modules/htmljs-parser'`. Bun (1.4.2, and the pinned 1.3.14 too) writes an empty `node_modules/htmljs-parser/.bun-tag-<hash>` file section at the top of the patch: delete those lines, then `rm -rf node_modules/.bun/htmljs-parser@<ver>* node_modules/htmljs-parser && bun install` to reinstall from the cleaned file. Left in, it breaks `packages/core/src/stock-parser.test.ts` (and its `@mxlang/target-html` twin), which reverses the patch onto a copy of the package and finds no such file.

The edits: an `attrValue` flag set where a named attribute's (or a spread's) value expression is entered, so `?` handling there skips `??` and `?.` and does not count them as ternaries. A spaced ` :b`, ` .b` or bare ` :` after a value continues the value, exactly as in stock 5.18.0.

It also makes every look-behind and look-ahead that decides whether a word starts or ends treat a non-ASCII identifier character as a word character (decision 156 addendum 13: a code point at or above U+0080 that is `ID_Continue`, or U+200C or U+200D, with a surrogate pair read as one code point; `isUnicodeWordCode`, `wordWidthBefore`, `wordWidthAt`. A symbol such as `©` is no word character, as in stock): division after a non-ASCII identifier (`x=é / 2`), names ending in a keyword (`x=énew y=1`), postfix `!`, member access across whitespace, `async` method names, `type` alias names and the ambiguous-`>` check. Stock 5.18.0 misreads all of these; the source copy's `PROVENANCE.md` lists each function. Every look-behind that asks whether a character is whitespace treats Unicode whitespace and line terminators as ASCII whitespace (decision 156 addenda 10 to 12: `(é)\u00a0/ 2` divides, `a +\u00a0` before a terminator continues), except in HTML body text, where only ASCII whitespace before `//` or `/*` starts a comment, as in Marko (addendum 13: `<p>Visit\u00a0//cdn.example/x.js</p>` is text). It also never throws (decision 165): a comment inside a text tag's open tag, a stray closing tag after a nameless concise tag (`,--/</e>`) and a nameless tag still open at the end of the input (`<,>a`) are an `onError`, not a `TypeError` out of `parse()`.

Known changes to valid input: none from the attribute-value rules. `x=a.b .c`, html-mode multi-line chains (`x=foo\n  .bar()`), and default attributes (`<if=a .b>`, `<const/x=items\n  .filter()/>`) read as in stock.

Published `@mxlang/*` packages do not carry this patch; a consumer install resolves stock `htmljs-parser`.

Bumped 5.15.0 to 5.18.0 with `@marko/compiler` 5.42.10 (which depends on `htmljs-parser ^5.17.1`): the original hunks applied with line offsets only, no hand porting.
