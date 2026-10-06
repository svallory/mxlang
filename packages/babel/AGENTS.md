# babel — agent instructions

`packages/babel` is the vendored `@babel/parser` fork (`src/`, see `UPSTREAM.md`
for the pin and every local modification) plus `src/mx-hooks.ts` and
`src/internal.ts`, which are ours alone and which `scripts/vendor.sh` keeps.

- Biome ignores only the fork's paths (`biome.json`: `src/{parser,plugins,tokenizer,util,parse-error}`
  and the fork's top-level files); the MX-owned files (`mx-hooks.ts`, `internal.ts`,
  `mx-ast.ts`, `mx-ast.test.ts`) are linted and format-checked. A new MX-owned
  file is covered automatically; a new fork file must be added to the ignore.
- **No MX logic here.** The fork reaches MX syntax only through `options.mxHooks`
  (`MxHooks`: `parseRegion`, `multipleRootsError`). `@mxlang/tsx-bridge`
  implements them. Never import `@mxlang/tsx-bridge`, a host, or `htmljs-parser`
  from this package; `scripts/workspace-cycles.test.ts` fails on a cycle.
- `mxHooks` must stay in `OptionsWithDefaults`' defaults and `KeepOptionalKeys`
  (`src/options.ts`), or `getOptions` drops it.
- `mx: true` without `mxHooks` is a thrown error in `getParser`, on purpose.
- Typecheck with `bun run typecheck` (relaxed tsconfig, whole package). The tests
  for the fork run in `packages/tsx-bridge` (`vendored.test.ts` pins that,
  without `mx`, it equals npm `@babel/parser`).
- `src/mx-ast.ts` (subpath `@mxlang/babel/mx-ast`, types only, not re-exported
  from `index.ts`) holds the MX AST node types, transcribed from
  `apps/docs/docs/architecture/ast.md`. `src/mx-ast.test.ts` is this package's
  own vitest project (`bun run test`): it reads ast.md's Appendix A, so adding a
  type means adding its Appendix row. The one test that needs `@mxlang/parser`
  (`MxErrorCode` equals the template parser's codes) lives in
  `packages/parser/src/mx-error-code.test.ts`; this package keeps zero
  workspace dependencies.
