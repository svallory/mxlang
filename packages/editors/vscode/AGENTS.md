# vscode — agent instructions

## How the TS plugin is shipped in the VSIX

`contributes.typescriptServerPlugins` names `@mxlang/typescript-plugin`, and VS Code's TypeScript extension loads it from `<extension dir>/node_modules`. The plugin is a private workspace package and not a dependency of the extension, and `vsce package --no-dependencies` never ships `node_modules` (vsce globs with `ignore: node_modules/**`), so a plain `vsce package` produced a VSIX with no plugin and every TS-plugin feature (`.mx`, `.solid.mx`, `.ng.mx`, `.amx`) dead in an installed extension.

`bun run package` (`scripts/stage-vsix.ts`) therefore builds the VSIX from a stage, `.vsix-stage/` (gitignored):

- the extension files plus `.vscodeignore` (`!node_modules/**`);
- `node_modules/@mxlang/typescript-plugin/dist/*.cjs`, bundled from the plugin's `src` so `@mxlang/*`, volar and babel are inlined. Entries are `src/index.ts` plus `src/<name>.ts` for every extra `dist/<name>.cjs` the plugin's own build emits (e.g. the Angular worker): a new worker entry needs no change here, but it must have a same-named `src/<name>.ts`;
- `@marko/compiler` and `@astrojs/compiler` with their dependency closure, **copied from the workspace install** (walked with `package.json` dependencies and `realpath`; a second version of a name nests under its dependent). Not `bun install`ed: that floated transitive versions (`htmljs-parser` 5.18.0 shipped against 5.15.0 locked) and needed the registry. The plugin loads the first through `createRequire`, the second reads a wasm file beside itself, so neither bundles;
- never shipped: `typescript` and `@angular/compiler-cli` (the forked Angular worker resolves both from the user's project with `createRequire(projectDir)`; tsserver passes the plugin its own `ts`), `@astrojs/language-server` (optional peer).

Entries come from the plugin's `build` script (`scripts/plugin-entries.ts`: `bun build src/<entry>.ts ... --outdir`), not from a `dist/` listing, and both scripts throw when the plugin's `dist/` is missing (run `bun run build` first).

vsce must walk dependencies itself (`npm list --production`, a vsce internal, not our package manager) to include `node_modules`, so the stage `package.json` declares the three packages; the extension's own `package.json` is unchanged.

`bun run check-vsix` (`scripts/check-vsix.ts`, unit-tested in `scripts/check-vsix.test.ts`, run in the CI `vscode-extension` job) unpacks the VSIX and asserts: the plugin resolves from the extension root; it ships a `dist/<entry>.cjs` for every entry of the plugin's `build` script; `require(entry)` is a factory **function** that returns `{ create }` when called with the real `typescript` (tsserver skips a module that is not one); every bare `require("x")` in a shipped `dist/*.cjs` resolves from that file, except the project-resolved allow-list (`@angular/compiler-cli`, `typescript`, `@astrojs/language-server`; `PROJECT_RESOLVED` in `check-vsix.ts`); every shipped package version is one `bun.lock` pins; `@angular/compiler-cli` and `typescript` are not shipped. It needs the plugin built first (`bun run build`). A dependency added to the plugin that cannot be bundled belongs in `INSTALLED` in `stage-vsix.ts`; the check then finds its require by itself.

The factory-function assertion depends on the plugin's own build emitting `module.exports = factory` (PR `fix/typescript-plugin-cjs-factory`); until that merges it, and so `check-vsix` on a real VSIX, stays red.

Known limitation: `{ astro: true }` composition for `.amx` does not work from the VSIX, because the plugin's `createRequire(import.meta.url)("@astrojs/language-server/...")` resolves from the plugin's location and the optional peer is not shipped. Fixing it means resolving the peer from the project.

Do not launch VS Code or install the VSIX to verify this; the check is the gate.
