# @mxlang/language-server

## Unreleased

### Changed

- **`x.astro.mx` is routed by kind** (amx-to-astro-mx, decision 134): the server watches `**/*.astro.mx` (it watched `**/*.amx`), and an `.astro.mx` document no longer reaches the `.mx` compile; it is silent, like `.ng.mx`, since Astro-template diagnostics come from `mx-tsc --astro` and the TS plugin.

### Added

- **`data.codeFrame` on compile-error diagnostics**: the compiler's code frame (ANSI-free, dedented to its `> 1 |` marker) moves out of `message`, which now holds only the error text (about 38 tokens down to 6 on a simple case). Messages with no frame are unchanged. A callee-template parse error keeps its "custom tag threw" header, names the callee as `(in <path>:L:C)` and gets `relatedInformation` there.
- **A VSIX-only self-contained build** (relocatable: `import.meta.url` resolves from the bundle at run time) (`build/bundled.ts`, `bun build/bundled.ts`): `src/bin.ts` bundled to `bundle/bin.cjs` (gitignored, outside `files`) with `@mxlang/*` and `vscode-languageserver` inlined and `@marko/compiler` external, from one list (`build/bundled-config.ts`). The `@mxlang/vscode` VSIX ships it. The npm tarball, `files`, `package.json` and the public exports are unchanged.

- **Host-policy warnings** (host-policy-walk-edge-cases): a malformed `package.json` (the document is compiled as `html`, and the warning names the ancestor whose host it used to take) or an unknown `mx.host` is published as a warning on the open document, worded like the scan's (`<package.json>: message`). `diagnoseDocument` takes an optional trailing `hostPolicyDiagnostics` argument; omitting it leaves the output exactly as before. (`mx-tsc` and the editor's TypeScript plugin do not surface these warnings.)

### Fixed

- **Fixing a `package.json` clears its diagnostics** (review of the host-policy location fix): the server now watches `**/package.json` and records the nearest `package.json` (plus any a diagnostic names) as a dependency of each document, so a fix re-diagnoses every open document that read it and clears the `package.json` copy and both `.mx` copies without editing them. The `.mx` message names the `package.json` once (core's own leading path is dropped), and the `.solid.mx` branch compiles under the file path, not the URI.
- **Host-policy diagnostics are located where they can be acted on** (audit item 8; h23, h24, a24): they were published on the `.mx` URI at *package.json's* line:column, a coordinate that means nothing there. The `.mx` now gets the warning at 1:1 with the message `<package.json>:<line>:<col>: <message>` (1-based, like `mx-tsc`) and `relatedInformation` pointing at the real range; the same problem is also published on the `package.json` URI at that range, and cleared when the last open document reporting it recovers or closes. The `mx.tags` scan warnings follow the same rule. Both, because the VS Code client's `documentSelector` covers only `mx`/`solidmx`: an agent or editor that reads only the `.mx`'s diagnostics still gets an exact `package.json:line:col`.
- **`diagnoseDocument` passes a file path, not the URI, to the compiles** (ls-uri-path-in-messages): the react, preact, hono, html and solid-unit compiles were handed a `file://` URI, so their messages named `<cwd>/file:/...`.
- **No false "angular host is not wired" Error** (ls-angular-not-wired): `diagnoseDocument` no longer throws a severity-1 error at 1:1 on every Angular-host document, clean ones included (25 of 26 audit angular cases). Angular-host documents now get no diagnostics from the server; `mx-tsc` and the TypeScript plugin own them (host-policy warnings are still published). Wiring `@mxlang/angular` into the server is tracked as `ls-angular-host-wiring`.
- **A `.ng.mx` never reaches the html compile** (audit a24: an `.ng.mx` under a typo'd `mx.host`, resolved to the html default, got html's `@tags must be nested within another element`). Routed by file kind first (`hostModuleSegment`), as `mx-tsc` does. An unknown `mx.host` on an `.mx` page compiles under the host the resolver returns plus the warning, matching `mx-tsc` and vite (parity test in `@mxlang/tsc`).

- **The tarball ships only `dist/` and the README** (pkg-types-g10): `tsconfig.build.json` excludes `src/**/fixtures/**` (`dist/fixtures/…/stamp.tag.d.ts.map` is gone) and turns `declarationMap` off.

### Documented

- A consumer that typechecks this package's declarations needs `@types/node` (installed and loaded): `dist/index.d.ts` re-exposes `vscode-languageserver/node`, whose own declarations use `NodeJS` and `child_process`. See the README.
