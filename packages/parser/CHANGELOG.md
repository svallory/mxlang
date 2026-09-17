# @mxlang/parser changelog

## Unreleased

- **BREAKING:** `parse`/`print` of a `.solid.mx` (or any file with `mx: true`)
  now require `mxRegionCompile`. The parser no longer imports `@mxlang/solid`
  or any other host — with the grammar on and no `mxRegionCompile` supplied, a
  region raises a positioned compile error naming the option and pointing at
  `compileSolidMx` from `@mxlang/solid` for `.solid.mx`. Every in-repo caller
  (the Vite plugin, the TypeScript plugin, the language server, the oracle)
  now imports `@mxlang/solid` itself and passes `compileSolidMx` explicitly.
  `@mxlang/solid` moved from `dependencies` to `devDependencies` in this
  package's own `package.json`.
- Fixed: `src/public.d.ts` re-exported `MxRegionContext`/`MxRegionPositionCheck`
  and the `mxRegionCompile` types through relative imports inside the ambient
  `declare module` block — a TS2439 every consumer's `skipLibCheck: true`
  silently swallowed into `any`. Those types are now declared inline in
  `public.d.ts`, with `src/public-types.test.ts` asserting two-way
  assignability against the real shapes so the two copies cannot drift
  unnoticed.
