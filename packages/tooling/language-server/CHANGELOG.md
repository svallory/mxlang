# @mxlang/language-server

## Unreleased

### Fixed

- **The tarball ships only `dist/` and the README** (pkg-types-g10): `tsconfig.build.json` excludes `src/**/fixtures/**` (`dist/fixtures/…/stamp.tag.d.ts.map` is gone) and turns `declarationMap` off.

### Documented

- A consumer that typechecks this package's declarations needs `@types/node` (installed and loaded): `dist/index.d.ts` re-exposes `vscode-languageserver/node`, whose own declarations use `NodeJS` and `child_process`. See the README.
