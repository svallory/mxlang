# @mxlang/language-server

## Unreleased

- **Fix (translate-error-callee-file):** callee syntax errors are published on the callee URI at its real range. Caller pointers include the file and 1-based line/column and link to that range. An aggregate callee (several Marko parser errors in one file) says how many further errors its code frame holds, on the callee diagnostic and the caller's pointer alike.

### Fixed: no page compile after a target load failure (registration PR 7 round 2)

When the policy carries `target-not-found`, `target-load-failed`, `target-invalid-descriptor` or `host-invalid-descriptor`, the server reports the policy and scan diagnostics only. The fallback target's verdict on a page written for the missing one no longer buries the real error.

### Added: third-party targets (registration PR 7)

`diagnoseDocument` compiles through the descriptor a package specifier under `mx.target` / `mx.host` loaded (`policy.descriptor`), with that project's lookup. The new `target-not-found`, `target-load-failed`, `target-invalid-descriptor` and `host-invalid-descriptor` errors reach the document, linked to the key in `package.json`, through the existing policy-diagnostics path. The language server finds a target the project installed even when it runs as the VSIX-bundled copy: the specifier is resolved from the project, never from the bundle.

### Fixed (mx.contracts PR 2, decision 142)

- Scanned contracts modules, sidecars and tag files are now caller dependencies.
  A watched-file edit re-diagnoses open callers without a page edit, including
  after a failed compile. Bun reloads edited declarations; Node ESM/TS reload
  still requires restart (`sync-esm-reload-node`).

### Added: target selection errors (target-select, decisions 129/132)

`mx.target` selects its target's host behaviour. Invalid targets and
host/target mismatches are errors on the document and `package.json`, with
full value ranges; mismatches link back to `mx.host`. Existing host warnings
are unchanged. Explicit `data` reports the registry's decision 131 addendum
error naming `parseData` and `TODO data-target-tooling-dispatch`.

### Changed (refactor/target-open-set, decisions 129 and 132)

The server resolves host policy and scans through `@mxlang/target-registry`'s wrappers over the built-in lookup, so it no longer depends on core's deleted closed lists; `diagnoseDocument` takes a policy whose `target` names the target and whose `host` is set only for a target that has one, and matches `mx.tags[].hosts` on `hostFilterKey(policy.target)` — the same string as before for every built-in. Compiles carry the built-in lookup, so a callee importing `AttrTag` from any registered target's package still reads. `isTranslateError` replaces `instanceof TranslateError`, so a positioned error from another copy of core keeps its position and dependencies. No change in the diagnostics published for any document.

### Changed

- **`x.astro.mx` is routed by kind** (amx-to-astro-mx, decision 134): the server watches `**/*.astro.mx` (it watched `**/*.amx`), and an `.astro.mx` document no longer reaches the `.mx` compile; it is silent, like `.ng.mx`, since Astro-template diagnostics come from `mx-tsc --astro` and the TS plugin.

### Fixed

- **A compile error no longer ends in Babel's 0-based ` (L:C)`** (ts-plugin-ts80001-babel-suffix): `… opening "span" tag at 1:23 (1:32)` is now `… opening "span" tag at 1:23`, matching `mx-tsc` and the TypeScript plugin.

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
