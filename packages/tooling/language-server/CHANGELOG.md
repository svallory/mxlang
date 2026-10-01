# @mxlang/language-server

## Unreleased

### Added

- **A VSIX-only self-contained build** (relocatable: `import.meta.url` resolves from the bundle at run time) (`build/bundled.ts`, `bun build/bundled.ts`): `src/bin.ts` bundled to `bundle/bin.cjs` (gitignored, outside `files`) with `@mxlang/*` and `vscode-languageserver` inlined and `@marko/compiler` external, from one list (`build/bundled-config.ts`). The `@mxlang/vscode` VSIX ships it. The npm tarball, `files`, `package.json` and the public exports are unchanged.

- **Host-policy warnings** (host-policy-walk-edge-cases): a malformed `package.json` (the document is compiled as `html`, and the warning names the ancestor whose host it used to take) or an unknown `mx.host` is published as a warning on the open document, worded like the scan's (`<package.json>: message`). `diagnoseDocument` takes an optional trailing `hostPolicyDiagnostics` argument; omitting it leaves the output exactly as before. (`mx-tsc` and the editor's TypeScript plugin do not surface these warnings.)

### Fixed

- **The tarball ships only `dist/` and the README** (pkg-types-g10): `tsconfig.build.json` excludes `src/**/fixtures/**` (`dist/fixtures/…/stamp.tag.d.ts.map` is gone) and turns `declarationMap` off.

### Documented

- A consumer that typechecks this package's declarations needs `@types/node` (installed and loaded): `dist/index.d.ts` re-exposes `vscode-languageserver/node`, whose own declarations use `NodeJS` and `child_process`. See the README.
