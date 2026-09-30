# vscode — agent instructions

## How the TS plugin is shipped in the VSIX

`contributes.typescriptServerPlugins` names `@mxlang/typescript-plugin`, and VS Code's TypeScript extension loads it from `<extension dir>/node_modules`. The plugin is a private workspace package and not a dependency of the extension, and `vsce package --no-dependencies` never ships `node_modules` (vsce globs with `ignore: node_modules/**`), so a plain `vsce package` produced a VSIX with no plugin and every TS-plugin feature (`.mx`, `.solid.mx`, `.ng.mx`, `.amx`) dead in an installed extension.

`bun run package` (`scripts/stage-vsix.ts`) therefore builds the VSIX from a stage, `.vsix-stage/` (gitignored):

- the extension files plus `.vscodeignore` (`!node_modules/**`);
- `node_modules/@mxlang/typescript-plugin/dist/*.cjs`, bundled from the plugin's `src` so `@mxlang/*`, volar and babel are inlined. Entries are `src/index.ts` plus `src/<name>.ts` for every extra `dist/<name>.cjs` the plugin's own build emits (e.g. the Angular worker): a new worker entry needs no change here, but it must have a same-named `src/<name>.ts`;
- `@marko/compiler` and `@astrojs/compiler`, installed with `bun install --production`: the plugin loads the first through `createRequire`, the second reads a wasm file beside itself, so neither bundles;
- never shipped: `typescript` (type-only; tsserver passes the plugin its `ts`), `@angular/compiler-cli` (resolves from the user's project), `@astrojs/language-server` (optional peer).

vsce must walk dependencies itself (`npm list --production`, a vsce internal, not our package manager) to include `node_modules`, so the stage `package.json` declares the three packages; the extension's own `package.json` is unchanged.

`bun run check-vsix` (`scripts/check-vsix.ts`, unit-tested in `scripts/check-vsix.test.ts`, run in the CI `vscode-extension` job) unpacks the VSIX and asserts the plugin resolves from the extension root, ships every `dist/*.cjs` the plugin's built `dist/` has, can resolve its runtime requires, and that `@angular/compiler-cli` and `typescript` are absent. It needs the plugin built first (`bun run build`). A dependency added to the plugin that cannot be bundled belongs in `INSTALLED` in `stage-vsix.ts` and `RUNTIME_REQUIRES` in `check-vsix.ts`.

Do not launch VS Code or install the VSIX to verify this; the check is the gate.
