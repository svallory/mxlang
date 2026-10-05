# @mxlang/babel

A vendored copy of `@babel/parser` 7.29.8 (TypeScript source) with one plugin
function forked: in expression position `<` can open an MX region instead of a
JSX element. The fork has no MX logic of its own. It calls an injected hook
object, `mxHooks` (`src/mx-hooks.ts`, type `MxHooks`), which
`@mxlang/tsx-bridge` supplies; `mx: true` without `mxHooks` throws.

- `src/index.ts` — `parse`, `parseExpression`, the option and result types and
  the hook types.
- `src/internal.ts` — what the bridge builds on (`ParseErrorEnum`, the
  tokenizer context types, `Position`). Not a stable surface for anyone else.
- `src/mx-hooks.ts` — the contract between the fork and the bridge: `MxHooks`,
  `MxParserHost`, the region compile types and the region-context types.
- `UPSTREAM.md` — the pin, what was dropped, every local modification, and how
  to re-vendor (`scripts/vendor.sh`).

The package is private and has no build: `@mxlang/tsx-bridge` bundles it into
its `dist/`. It depends on nothing in the repo but `@mxlang/core`, for one
type (`CustomTag`).
