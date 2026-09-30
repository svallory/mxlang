---
title: "VS Code"
description: "Highlighting for .mx, .solid.mx, .ng.mx, and .amx files in VS Code, plus formatting and diagnostics for .mx and .solid.mx."
---

# VS Code

The official `@mxlang/vscode` extension provides highlighting, language server integration, and TypeScript diagnostics for MX. `.ng.mx` gets highlighting and TypeScript semantics; the language server and Angular template diagnostics come later.

Since the extension is not yet published to the VS Code Marketplace, you must install it manually from the `.vsix` artifact generated in CI.
Download `mxlang.vsix` from the latest GitHub Actions run on `main` and run:

```bash
code --install-extension mxlang.vsix
```

## Highlighting

The extension provides:
- **MX (`.mx`, `.marko`)**: Full highlighting powered by the official Marko TextMate grammar.
- **AstroMX (`.amx`)**: Highlighting for the Astro frontmatter and delegates the body to the Marko grammar.
- **SolidMX (`.solid.mx`)**: Highlighting as `source.tsx`. *Note: True grammar injection for MX regions within SolidMX is not feasible via regex alone, so `.solid.mx` falls back to standard TSX highlighting for now.*
- **AngularMX (`.ng.mx`)**: Highlighting as `source.tsx`, the same fallback as SolidMX — an ordinary TypeScript module whose `@Component` template is MX. The TypeScript plugin compiles it as its own file kind, so TypeScript semantics work: errors in the component class and module are reported at their `.ng.mx` position. Angular template diagnostics (checking the expressions inside `template:`) also appear in the editor: Angular's compiler runs in a background process, 1 second after you stop typing (or on save, or never, per `package.json#mx.angular.diagnostics`), and needs `@angular/compiler-cli` `>=22 <23` in your project. The language server does not handle `.ng.mx` yet.

## Formatting

Format `.mx` files with `prettier-plugin-marko`'s Marko parser. Add this to your Prettier configuration:

```json
{
  "overrides": [
    { "files": "*.mx", "options": { "parser": "marko" } }
  ]
}
```

This requires `prettier` and `prettier-plugin-marko` to be installed in your project.

## Diagnostics

The extension automatically starts `@mxlang/language-server` for `.mx` and `.solid.mx` files. (Note: The language server does not currently handle `.amx` or `.ng.mx` files.)

### Command Resolution
The extension looks for the language server in the following order:
1. A local workspace install at `node_modules/.bin/mxlang-language-server`
2. A global install via your system's `PATH`
3. `bunx @mxlang/language-server --stdio`
4. `npx @mxlang/language-server --stdio`

### Settings
You can override the path to the language server executable using the `mxlang.languageServer.path` setting:

```json
{
  "mxlang.languageServer.path": "/absolute/path/to/mxlang-language-server"
}
```

### Commands
- `MX: Restart Language Server` (`mxlang.restartLanguageServer`): Restarts the language server process.

## TypeScript

The extension automatically contributes `@mxlang/typescript-plugin` to VS Code's internal TypeScript server for `.mx`, `.solid.mx`, and `.amx` files.

You do **not** need to configure `typescript.tsserver.pluginPaths` or `compilerOptions.plugins` for editor diagnostics, as the extension injects the plugin directly.

*(Note: Command-line typechecking still requires `mx-tsc` instead of `tsc` because `tsc` ignores `compilerOptions.plugins`.)*
