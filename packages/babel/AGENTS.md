# babel — agent instructions

`packages/babel` is the vendored `@babel/parser` fork (`src/`, see `UPSTREAM.md`
for the pin and every local modification) plus `src/mx-hooks.ts` and
`src/internal.ts`, which are ours alone and which `scripts/vendor.sh` keeps.

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
