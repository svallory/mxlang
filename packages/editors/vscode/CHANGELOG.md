# @mxlang/vscode

## 0.0.0 (unreleased)

### Fixed: the VSIX ships `@mxlang/language-server` and prefers it

`@mxlang/language-server` was found only through `bunx`/`npx`/a workspace or global install, and none of them can provide it (not on npm), so in-file host-policy diagnostics did not work for a real user. `bun run package` now also runs the language server's self-contained build and stages it at `node_modules/@mxlang/language-server/dist/bin.cjs` (with `@marko/compiler`, shared with the plugin). `getServerCommand` resolves `mxlang.languageServer.path`, then the bundled server (run by `LanguageClient` through `module`, stdio, on VS Code's Node); the workspace/global/`bunx`/`npx` lookups only run when the bundle is missing. `check-vsix` asserts the server resolves inside the VSIX with its closure, and `bun run ls-smoke` (a CI step, `node`) starts it from the unpacked VSIX and expects exactly one diagnostic. `mxlang.languageServer.path` is now documented as an override of the bundled server. The build and closure copy are shared with the plugin (`scripts/bundled-build.ts`, `scripts/closure.ts`).

### Fixed: the VSIX ships `@mxlang/typescript-plugin`

The CI build packed the VSIX with `vsce package --no-dependencies`, which ships no `node_modules`, so `contributes.typescriptServerPlugins` named a plugin that was not in the installed extension and no TS-plugin feature worked. `bun run package` now stages a self-contained `node_modules/@mxlang/typescript-plugin` (bundled, plus `@marko/compiler` and `@astrojs/compiler`; never `@angular/compiler-cli`), and `bun run check-vsix`, run in the CI `vscode-extension` job, fails when the plugin entry does not resolve from the extension root. The VSIX grows from about 140 KB to about 3.4 MB.

The staged dependencies are copied from the workspace install instead of installed fresh, so the shipped versions are the ones `bun.lock` pins (the VSIX grows to about 3.8 MB with the Angular worker). `check-vsix` also asserts the plugin entry is a factory function that returns `{ create }` (red until `fix/typescript-plugin-cjs-factory` merges), derives the expected `dist` entries from the plugin's `build` script, scans shipped bundles for bare requires that do not resolve, and compares shipped versions with `bun.lock`. `{ astro: true }` composition for `.amx` does not work from the VSIX yet (the optional peer resolves from the plugin's location).

The staged plugin is now a copy of the plugin package's own self-contained build (`build:bundled`, `bundle/`), so it gets the same factory-function export as the published build, and the entries and externals live in one list (`build/bundled-config.ts`). `bun run tsserver-load`, a CI step, loads the unpacked VSIX's plugin in a real tsserver. `check-vsix` no longer fails on the factory shape: it is fully green.
