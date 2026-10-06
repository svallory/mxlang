# patches

Bun `patchedDependencies` (root `package.json`). `bun install` applies them; `bun.lock` records them.

## `htmljs-parser@5.18.0.patch`

After whitespace inside an attribute value, `:name` and `.name` start a new attribute instead of continuing the value (decision 146, `divergences.md`):

```
<a x="1" :b/>      →  x="1"  :b
<a x=a.b .c/>      →  x=a.b  .c       (was member access across the space)
<a x=1 ? y : z/>   →  unchanged        (an open ? owns its :)
<a x=(a.b .c)/>    →  unchanged        (parentheses keep member access)
```

The patch edits both published builds (`dist/index.js`, `dist/index.mjs`). Tests: `patches/htmljs-parser.test.ts` (vitest project `patches`). It also changes how stock Marko in `packages/oracle` parses the same input.

It also lexes **atoms** (decision 156): in attribute values, attribute and tag arguments, placeholders and their templates' `${}`, a `:name` where an expression is expected is an atom, `read()` hands the compiler a same-length numeric stand-in for it (`:a` → `0.`), and `::name` is a reserved-token error. The ternary counter skips an atom's `:`, so `x=a ? :b :c` is one value. The source copy `packages/parser/src/template/` carries the same change; its `PROVENANCE.md` "Atoms" section is the description and the API (`onAtom`, the stand-in), and `packages/parser/src/template/mx-atoms.cases.ts` is the one case table both suites run.

**Lockstep with the source copy.** Nothing generates one from the other: the copy's TypeScript and the patch's JavaScript are edited by hand to the same logic (the patch's helpers are the copy's, transpiled by hand in esbuild's style), and three tests hold them together: `corpus-equivalence.test.ts` (identical event streams over the repo corpus, `onAtom` included), the shared atom case table, and the decision 146 tables (`mx-after-value.test.ts` here is `htmljs-parser.test.ts` re-pointed). Change both in one commit.

To regenerate on a version bump (or to change the rule), in this order (`bun install` aborts while `patchedDependencies` points at a missing file):

1. `TMP=$(mktemp -d) && git show HEAD:patches/htmljs-parser@<old>.patch > "$TMP/old.patch"`
2. Delete the `patchedDependencies` entry from the root `package.json` (don't bump it) and `git rm` the old patch file.
3. Bump the version, then `bun install`.
4. `bun patch htmljs-parser@<new>`, then inside the printed folder `patch -p1 < "$TMP/old.patch"` (fix rejects by hand; it edits both dist files).
5. `bun patch --commit 'node_modules/htmljs-parser'` (re-adds the entry), then `bunx vitest run --project patches`.

To change the rule without a version bump: `bun patch htmljs-parser@<ver>` (the printed `node_modules/htmljs-parser` already has the current patch applied), edit both dist files, `bun patch --commit 'node_modules/htmljs-parser'`. Bun (1.4.2, and the pinned 1.3.14 too) writes an empty `node_modules/htmljs-parser/.bun-tag-<hash>` file section at the top of the patch: delete those lines, then `rm -rf node_modules/.bun/htmljs-parser@<ver>* node_modules/htmljs-parser && bun install` to reinstall from the cleaned file. Left in, it breaks `packages/core/src/stock-parser.test.ts` (and its `@mxlang/html` twin), which reverses the patch onto a copy of the package and finds no such file.

The edits: an `attrValue` flag set where a named attribute's (or a spread's) value expression is entered — not for a default attribute (`<if=a .b>`, `<const/x=…>`), which is exempt, except that a `defaultAtom` flag marks a default value and `isSingleAtomDefault` lets ` :ident` end it when the whole value so far is one atom (`belongs-to=:Customer :customer`, decision 146 addendum 5); `?` handling skips `??` and `?.` so they do not count as ternaries; `lookAheadForOperator` ends the value at ` :ident` (no open `?`) and ` .ident`; a small `isIdentStartCode` helper. The `:` check also ends the value at a bare `:` right before `/>`, `>`, a newline or the end of the source, so core can report "`:` is name sugar and needs a name".

It also makes every look-behind and look-ahead that decides whether a word starts or ends treat a non-ASCII identifier character as a word character (decision 156 addendum 9: any code unit at or above U+0080 except Unicode whitespace and line terminators; `isUnicodeWordCode`): division after a non-ASCII identifier (`x=é / 2`), names ending in a keyword (`x=énew y=1`), postfix `!`, member access across whitespace, `async` method names, `type` alias names and the ambiguous-`>` check. Stock 5.18.0 misreads all of these; the source copy's `PROVENANCE.md` lists each function. It also never throws (decision 165): a comment inside a text tag's open tag and a stray closing tag after a nameless concise tag (`,--/</e>`) are an `onError`, not a `TypeError` out of `parse()`.

Known changes to valid input: the `.` half changes `x=a.b .c` and html-mode multi-line chains (`x=foo\n  .bar()`), but not default attributes (`<if=a .b>`, `<const/x=items\n  .filter()/>`), which keep Marko's meaning (decision 151), except a default value that is a single atom followed by ` :name` (decision 146 addendum 5). The `:` half changes two valid TS spellings, a return type written with a space before the colon and no space after it (`(a) :T => a`) or a newline after it (`(a) :\n T => a`); `(a): T` and `(a) : T` are unchanged.

Published `@mxlang/*` packages do not carry this patch; a consumer install resolves stock `htmljs-parser`.

Bumped 5.15.0 to 5.18.0 with `@marko/compiler` 5.42.10 (which depends on `htmljs-parser ^5.17.1`): the original hunks applied with line offsets only, no hand porting.
