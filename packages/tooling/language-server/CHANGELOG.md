# @mxlang/language-server

## Unreleased

### Added

- **Host-policy warnings** (host-policy-walk-edge-cases): a malformed `package.json` (the document is compiled as `html`, and the warning names the ancestor whose host it used to take) or an unknown `mx.host` is published as a warning on the open document, worded like the scan's (`<package.json>: message`). `diagnoseDocument` takes an optional trailing `hostPolicyDiagnostics` argument; omitting it leaves the output exactly as before. (`mx-tsc` and the editor's TypeScript plugin do not surface these warnings.)

### Fixed

- **The tarball ships only `dist/` and the README** (pkg-types-g10): `tsconfig.build.json` excludes `src/**/fixtures/**` (`dist/fixtures/…/stamp.tag.d.ts.map` is gone) and turns `declarationMap` off.

### Documented

- A consumer that typechecks this package's declarations needs `@types/node` (installed and loaded): `dist/index.d.ts` re-exposes `vscode-languageserver/node`, whose own declarations use `NodeJS` and `child_process`. See the README.
