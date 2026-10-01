# vscode — agent instructions

## How the TS plugin is shipped in the VSIX

`contributes.typescriptServerPlugins` names `@mxlang/typescript-plugin`, and VS Code's TypeScript extension loads it from `<extension dir>/node_modules`. The plugin is a private workspace package and not a dependency of the extension, and `vsce package --no-dependencies` never ships `node_modules` (vsce globs with `ignore: node_modules/**`), so a plain `vsce package` produced a VSIX with no plugin and every TS-plugin feature (`.mx`, `.solid.mx`, `.ng.mx`, `.amx`) dead in an installed extension.

`bun run package` therefore (1) builds the extension, (2) runs the plugin package's own **self-contained build** (`bun run build:bundled` in `packages/tooling/typescript-plugin`, output `bundle/`, gitignored and outside the plugin's `files`), and (3) `scripts/stage-vsix.ts` copies that output into a stage, `.vsix-stage/` (gitignored), and packs it:

- the extension files plus `.vscodeignore` (`!node_modules/**`);
- `node_modules/@mxlang/typescript-plugin/dist/*.cjs`: a plain **copy** of `bundle/`. The stage bundles nothing itself. The plugin build inlines `@mxlang/*`, volar and babel, applies `build/cjs-factory.ts` (so `index.cjs` exports the factory function tsserver requires; an earlier stage that re-bundled `src` shipped the object shape), and takes its entries and externals from one list, `build/bundled-config.ts` (`BUNDLED_ENTRIES`, `BUNDLED_INSTALLED`, `BUNDLED_PROJECT_RESOLVED`), which the stage and `check-vsix` also read. A new entry or external is added there only. This is a VSIX-only self-contained build: the npm tarball (`files: ["dist", "README.md"]`, `@mxlang/*` external) is unchanged;
- `@marko/compiler` and `@astrojs/compiler` (`BUNDLED_INSTALLED`) with their dependency closure, **copied from the workspace install** (walked with `package.json` dependencies and `realpath`; a second version of a name nests under its dependent). Not `bun install`ed: that floated transitive versions (`htmljs-parser` 5.18.0 shipped against 5.15.0 locked) and needed the registry. The plugin loads the first through `createRequire`, the second reads a wasm file beside itself, so neither bundles;
- never shipped (`BUNDLED_PROJECT_RESOLVED`): `typescript` and `@angular/compiler-cli` (the forked Angular worker resolves both from the user's project with `createRequire(projectDir)`; tsserver passes the plugin its own `ts`), `@astrojs/language-server` (optional peer).

The stage throws when `bundle/` is missing; `bun run package` builds it first.

vsce must walk dependencies itself (`npm list --production`, a vsce internal, not our package manager; root AGENTS.md lists this as an npm exception) to include `node_modules`, so the stage `package.json` declares the three packages; the extension's own `package.json` is unchanged.

`bun run check-vsix` (`scripts/check-vsix.ts`, unit-tested in `scripts/check-vsix.test.ts`, run in the CI `vscode-extension` job) unpacks the VSIX and asserts: the plugin resolves from the extension root; it ships a `dist/<entry>.cjs` for every `BUNDLED_ENTRIES` entry; `require(entry)` is a factory **function** that returns `{ create }` when called with the real `typescript` (tsserver skips a module that is not one); every bare `require("x")` in a shipped `dist/*.cjs` resolves from that file, except that a bundler-renamed callee (`require22(...)`, the `createRequire(projectDir)` results) may load the project-resolved modules: a plain `require("typescript")` fails (this depends on bun renaming `createRequire` results; if a bun upgrade stops that, the check fails loudly and the heuristic needs revisiting); every non-optional dependency of every shipped package resolves from that package's own location inside the VSIX (closure completeness); every shipped package version is one `bun.lock` pins; `@angular/compiler-cli` and `typescript` are not shipped.

`bun run tsserver-load` (`scripts/tsserver-load.ts`, also a CI step) is the real proof: it unpacks the VSIX and runs the plugin's `src/tsserver-load.test.ts` against `extension/` (`MX_VSIX_EXTENSION_DIR`), starting ONE real tsserver the way VS Code does (`--globalPlugins @mxlang/typescript-plugin --pluginProbeLocations <extension dir>`), with a request timeout and a kill on hang or exit. It needs no VS Code and no installed VSIX.

Known limitation: `{ astro: true }` composition for `.amx` does not work from the VSIX, because the plugin's `createRequire(import.meta.url)("@astrojs/language-server/...")` resolves from the plugin's location and the optional peer is not shipped. Fixing it means resolving the peer from the project.

Do not launch VS Code or install the VSIX to verify this; the check is the gate.

## Editor/build version skew

The VSIX pins `@mxlang/core`, `@mxlang/parser` and the host emitters at the extension's version, while a project's build uses its own installed `@mxlang/*`. While MX semantics still move, the editor can type a file differently from the build. If a project lists `@mxlang/typescript-plugin` in its tsconfig `compilerOptions.plugins` and has it installed, that copy is the one tsserver loads and the VSIX's global plugin is skipped: TypeScript 6.0.3 `lib/typescript.js:189300-189301` (`enableGlobalPlugins`: `if (options.plugins && options.plugins.some((p) => p.name === globalPluginName)) continue;`). That is the way to make the editor follow the project's version.
