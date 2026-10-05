# patches

Bun `patchedDependencies` (root `package.json`). `bun install` applies them; `bun.lock` records them.

## `htmljs-parser@5.15.0.patch`

After whitespace inside an attribute value, `:name` and `.name` start a new attribute instead of continuing the value (decision 146, `divergences.md`):

```
<a x="1" :b/>      →  x="1"  :b
<a x=a.b .c/>      →  x=a.b  .c       (was member access across the space)
<a x=1 ? y : z/>   →  unchanged        (an open ? owns its :)
<a x=(a.b .c)/>    →  unchanged        (parentheses keep member access)
```

The patch edits both published builds (`dist/index.js`, `dist/index.mjs`). Tests: `patches/htmljs-parser.test.ts` (vitest project `patches`). It also changes how stock Marko in `packages/oracle` parses the same input.

To regenerate on a version bump (or to change the rule), in this order (`bun install` aborts while `patchedDependencies` points at a missing file):

1. `TMP=$(mktemp -d) && git show HEAD:patches/htmljs-parser@<old>.patch > "$TMP/old.patch"`
2. Delete the `patchedDependencies` entry from the root `package.json` (don't bump it) and `git rm` the old patch file.
3. Bump the version, then `bun install`.
4. `bun patch htmljs-parser@<new>`, then inside the printed folder `patch -p1 < "$TMP/old.patch"` (fix rejects by hand; it edits both dist files).
5. `bun patch --commit 'node_modules/htmljs-parser'` (re-adds the entry), then `bunx vitest run --project patches`.

The edits: an `attrValue` flag set where a named attribute's (or a spread's) value expression is entered — not for a default attribute (`<if=a .b>`, `<const/x=…>`), which is exempt; `?` handling skips `??` and `?.` so they do not count as ternaries; `lookAheadForOperator` ends the value at ` :ident` (no open `?`) and ` .ident`; a small `isIdentStartCode` helper.

Known changes to valid input: the `.` half changes `x=a.b .c` and html-mode multi-line chains (`x=foo\n  .bar()`), but not default attributes (`<if=a .b>`, `<const/x=items\n  .filter()/>`), which keep Marko's meaning (decision 151). The `:` half changes one valid TS spelling, a return type written `(a) :T => a` (space before the colon, none after); `(a): T` and `(a) : T` are unchanged.

Published `@mxlang/*` packages do not carry this patch; a consumer install resolves stock `htmljs-parser`.
