# @mxlang/vscode

## 0.0.0 (unreleased)

### Fixed: the VSIX ships `@mxlang/typescript-plugin`

The CI build packed the VSIX with `vsce package --no-dependencies`, which ships no `node_modules`, so `contributes.typescriptServerPlugins` named a plugin that was not in the installed extension and no TS-plugin feature worked. `bun run package` now stages a self-contained `node_modules/@mxlang/typescript-plugin` (bundled, plus `@marko/compiler` and `@astrojs/compiler`; never `@angular/compiler-cli`), and `bun run check-vsix`, run in the CI `vscode-extension` job, fails when the plugin entry does not resolve from the extension root. The VSIX grows from about 140 KB to about 3.4 MB.

The staged dependencies are copied from the workspace install instead of installed fresh, so the shipped versions are the ones `bun.lock` pins (the VSIX grows to about 3.8 MB with the Angular worker). `check-vsix` also asserts the plugin entry is a factory function that returns `{ create }` (red until `fix/typescript-plugin-cjs-factory` merges), derives the expected `dist` entries from the plugin's `build` script, scans shipped bundles for bare requires that do not resolve, and compares shipped versions with `bun.lock`. `{ astro: true }` composition for `.amx` does not work from the VSIX yet (the optional peer resolves from the plugin's location).
