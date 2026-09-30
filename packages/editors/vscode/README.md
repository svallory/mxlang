# `@mxlang/vscode`

The official VS Code extension for MX. It provides syntax highlighting for MX (`.mx`), SolidMX (`.solid.mx`), AngularMX (`.ng.mx`), and AstroMX (`.amx`), plus language server integration and TypeScript diagnostics for `.mx` and `.solid.mx`. `.ng.mx` is highlighting-only until its tooling lands.

## Installation

The extension is currently not published to the Marketplace. Download the `mxlang.vsix` artifact from the latest GitHub Actions run on `main` and install it manually:

```bash
code --install-extension mxlang.vsix
```

## Features

- **Highlighting**: Accurate syntax highlighting for `.mx` and `.amx` files powered by the Marko TextMate grammar. (Note: `.solid.mx` and `.ng.mx` currently fall back to `source.tsx` highlighting due to regex grammar limitations).
- **Diagnostics**: Automatically launches `@mxlang/language-server` to provide template validation and type checking in the editor for `.mx` and `.solid.mx`. (`.ng.mx` and `.amx` are not handled by the language server yet.)
- **TypeScript**: Automatically registers `@mxlang/typescript-plugin` with VS Code's TypeScript language server for `.mx`, `.solid.mx`, and `.amx`. (Not `.ng.mx`: the plugin cannot project it yet.)

## Settings

- `mxlang.languageServer.path`: Absolute path to the `@mxlang/language-server` executable. If not specified, the extension will attempt to find a local installation in `node_modules`, then globally via `bunx` or `npx`.

## Commands

- `MX: Restart Language Server`: Restarts the language server process.
