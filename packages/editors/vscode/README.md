# `@mxlang/vscode`

The official VS Code extension for MX. It provides syntax highlighting for MX (`.mx`), SolidMX (`.solid.mx`), AngularMX (`.ng.mx`), and AstroMX (`.amx`), plus language server integration and TypeScript diagnostics for `.mx` and `.solid.mx`. `.ng.mx` gets TypeScript semantics and Angular template diagnostics (see below).

## Installation

The extension is currently not published to the Marketplace. Download the `mxlang.vsix` artifact from the latest GitHub Actions run on `main` and install it manually:

```bash
code --install-extension mxlang.vsix
```

## Features

- **Highlighting**: Accurate syntax highlighting for `.mx` and `.amx` files powered by the Marko TextMate grammar. (Note: `.solid.mx` and `.ng.mx` currently fall back to `source.tsx` highlighting due to regex grammar limitations).
- **Diagnostics**: Automatically launches `@mxlang/language-server` to provide template validation and type checking in the editor for `.mx` and `.solid.mx`. (`.ng.mx` and `.amx` are not handled by the language server yet.)
- **TypeScript**: Automatically registers `@mxlang/typescript-plugin` with VS Code's TypeScript language server for `.mx`, `.solid.mx`, `.ng.mx`, and `.amx`. For `.ng.mx` this gives TypeScript semantics for the component class and module (errors are reported at their `.ng.mx` position); Angular template diagnostics (errors inside `template:` expressions) are checked by Angular's compiler in a background process, 1 second after you stop typing or on save, per `package.json#mx.angular.diagnostics` (`"idle"` default, `"save"`, `"off"`). `@angular/compiler-cli` (`>=22 <23`) must be installed in your project.


The VSIX ships the TS plugin itself; see "How the TS plugin is shipped" below.

## Settings

- `mxlang.languageServer.path`: Absolute path to the `@mxlang/language-server` executable. If not specified, the extension will attempt to find a local installation in `node_modules`, then globally via `bunx` or `npx`.

## Commands

- `MX: Restart Language Server`: Restarts the language server process.

## How the TS plugin is shipped

The VSIX carries a self-contained `node_modules/@mxlang/typescript-plugin` (bundled, plus `@marko/compiler` and `@astrojs/compiler`), because VS Code's TypeScript server resolves `typescriptServerPlugins` from the extension's own `node_modules`. `@angular/compiler-cli` and `typescript` are never shipped; the Angular diagnostics worker resolves both from your project, so both must be installed there. Limitation: `{ astro: true }` composition (for `.amx`) does not work from the VSIX yet, because `@astrojs/language-server` resolves from the plugin's own location and is not shipped. Build the VSIX with `bun run package` and verify it with `bun run check-vsix`; see `AGENTS.md` for the details.
