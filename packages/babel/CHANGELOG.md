# @mxlang/babel changelog

- **Added (parser-split, decision 158):** the vendored Babel fork moves here from `@mxlang/parser`. It no longer imports the MX bridge: MX syntax is injected through the `mxHooks` parser option (`MxHooks`, `src/mx-hooks.ts`), and `mx: true` without hooks throws. `src/internal.ts` documents what `@mxlang/tsx-bridge` builds on. No change to what parses or to any AST.
