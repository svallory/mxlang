# @mxlang/tsc

## Unreleased

### Fixed

- **The tarball ships only `dist/` and the README** (pkg-types-g10): `files` is now `["dist", "README.md"]`, so `src/`, the test fixtures and `moon.yml` (115 files) no longer ship. `types` is dropped: it pointed at `src/index.ts`, and `bun build` emits no declarations. Nothing imports `@mxlang/tsc` as a TypeScript module; the package is used through its `mx-tsc` bin. `scripts/pack-probe.ts` installs the packed tarball and runs `mx-tsc --version`.
