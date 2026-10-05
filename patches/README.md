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

To regenerate on a version bump (or change the rule): `git rm` the old patch, `bun install`, `bun patch htmljs-parser@<version>`, re-apply the edits to both dist files (`patch -p1 < <old patch>` inside the folder, then fix rejects), `bun patch --commit 'node_modules/htmljs-parser'`, and run `bunx vitest run --project patches`. The edits: an `attrValue` flag set where an attribute value expression is entered; `lookAheadForOperator` ends the value at ` :ident` (no open `?`) and ` .ident`; `?` handling skips `??` and `?.` so they do not count as ternaries.

Published `@mxlang/*` packages do not carry this patch; a consumer install resolves stock `htmljs-parser`.
