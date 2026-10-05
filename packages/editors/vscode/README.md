# `@mxlang/vscode`

The official VS Code extension for MX. It provides syntax highlighting for MX (`.mx`), Solid (`.solid.mx`), AngularMX (`.ng.mx`), and AstroMX (`.astro.mx`), plus language server integration and TypeScript diagnostics for `.mx` and `.solid.mx`. `.ng.mx` gets TypeScript semantics and Angular template diagnostics (see below).

## Installation

The extension is currently not published to the Marketplace. Download the `mxlang.vsix` artifact from the latest GitHub Actions run on `main` and install it manually:

```bash
code --install-extension mxlang.vsix
```

## Features

- **Highlighting**: Accurate syntax highlighting for `.mx` and `.astro.mx` files powered by the Marko TextMate grammar. (Note: `.solid.mx` and `.ng.mx` currently fall back to `source.tsx` highlighting due to regex grammar limitations).
- **Diagnostics**: Automatically launches `@mxlang/language-server` to provide template validation and type checking in the editor for `.mx` and `.solid.mx`. (`.ng.mx` and `.astro.mx` are not handled by the language server yet.)
- **TypeScript**: Automatically registers `@mxlang/typescript-plugin` with VS Code's TypeScript language server for `.mx`, `.solid.mx`, `.ng.mx`, and `.astro.mx`. For `.ng.mx` this gives TypeScript semantics for the component class and module (errors are reported at their `.ng.mx` position); Angular template diagnostics (errors inside `template:` expressions) are checked by Angular's compiler in a background process, 1 second after you stop typing or on save, per `package.json#mx.angular.diagnostics` (`"idle"` default, `"save"`, `"off"`). `@angular/compiler-cli` (`>=22 <23`) must be installed in your project.


The VSIX ships the TS plugin and the language server themselves; see "What the VSIX ships" below.

## Settings

- `mxlang.languageServer.path`: Absolute path to an `@mxlang/language-server` executable that overrides the language server bundled with the extension. Leave empty to use the bundled one.

## Commands

- `MX: Restart Language Server`: Restarts the language server process.

## What the VSIX ships

**The language server.** The VSIX carries a self-contained `node_modules/@mxlang/language-server` (`dist/bin.cjs`, plus `@marko/compiler`), and VS Code runs it with its own Node over stdio, so it needs no Node, bun or package install on your machine. Resolution order: `mxlang.languageServer.path` if set, otherwise the bundled server. When the bundle is present nothing else is consulted: no workspace, global, `bunx` or `npx` server is used, so the editor always runs the language server version it shipped with. (A source checkout that never ran `bun run package` has no bundle, and then falls back to a workspace install, a global install, `bunx`, then `npx`.)

**The TS plugin.** The VSIX carries a self-contained `node_modules/@mxlang/typescript-plugin` (bundled, plus `@marko/compiler` and `@astrojs/compiler`), because VS Code's TypeScript server resolves `typescriptServerPlugins` from the extension's own `node_modules`. `@angular/compiler-cli` and `typescript` are never shipped; the Angular diagnostics worker resolves both from your project, so both must be installed there. Limitation: `{ astro: true }` composition (for `.astro.mx`) does not work from the VSIX yet, because `@astrojs/language-server` resolves from the plugin's own location and is not shipped. Build the VSIX with `bun run package` and verify it with `bun run check-vsix`; see `AGENTS.md` for the details.

Version skew: the VSIX pins its own `@mxlang/core`, `@mxlang/tsx-bridge` and host emitters per extension version, while your build uses the `@mxlang/*` your project installs, so editor typing can differ from the build while MX semantics are still moving. Editor typing follows the extension's bundled plugin version, even when the project installs and configures its own `@mxlang/typescript-plugin`.
