---
title: "TypeScript"
description: "Type-check SolidMX, whole-file MX, and AstroMX in editors and CI."
---

# TypeScript

TypeScript cannot parse a `.solid.mx` module, a whole-file `.mx` / `.marko`
template, or an AstroMX `.astro.mx` file. Without help, an editor cannot derive
their exports and an import is unresolved. MX projects the source to the
host's generated TypeScript and keeps diagnostics mapped to the original file.

Two packages fix that, sharing a single lowering so an editor and a build can
never disagree about whether a file compiles:

| | Package | Where it runs |
| --- | --- | --- |
| Editors | `@mxlang/typescript-plugin` | inside tsserver |
| CI | `@mxlang/tsc` (`mx-tsc`) | on the command line |

Both project each MX file to its lowered TS/TSX and type-check that, mapping
diagnostics back to the original file — at the exact column, not the start of
the expression:

```tsx
export const el = <button onClick() { setCount(count() + "x") }>x</button>;
//                                             ~~~~~~~~~~~~~
// TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
```

## Name sugar

A [name sugar](/language/attributes/) token (`:email`, `.big`, `#main`) maps to the
generated attribute it stands for (`name`, `class`, `id`) with the token's exact
source range, so a TypeScript error on that prop is reported on the token you
wrote.

## In an editor

Add the plugin to the project's `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@mxlang/typescript-plugin" }]
  }
}
```

Editor-specific wiring — Zed's `vtsls` `globalPlugins` entry, VS Code's
`typescript.tsserver.pluginPaths` — is on the [Zed](/editors/zed/) and
[VS Code](/editors/vscode/) pages.

VS Code can force-load the package for the workspace TypeScript server:

```json
{
  "typescript.tsserver.pluginPaths": [
    "./node_modules/@mxlang/typescript-plugin"
  ]
}
```

Zed's `vtsls` equivalent is:

```json
{
  "lsp": {
    "vtsls": {
      "settings": {
        "vtsls": {
          "typescript": {
            "globalPlugins": [
              {
                "name": "@mxlang/typescript-plugin",
                "location": "/absolute/path/to/node_modules/@mxlang/typescript-plugin",
                "languages": ["solidmx", "mx", "astro", "astromx"],
                "enableForWorkspaceTypeScriptVersions": true
              }
            ]
          }
        }
      }
    }
  }
}
```

Once it is loaded, an import from ordinary `.ts`/`.tsx` code is typed from the
file's real exports:

```tsx
import { Counter } from "./Counter.solid.mx";

export const bad = <Counter nope={1} />;
// TS2322: Property 'nope' does not exist on type 'IntrinsicAttributes'.
```

Do **not** also write an ambient `declare module "*.solid.mx"`, `"*.mx"`, or
`"*.marko"` shim. A shim
asserts types rather than deriving them, so it hides the real signature and
every error the plugin would have found. If a project has one from before, delete
it.

### Astro projects: one composed plugin

Astro's TypeScript plugin and MX's are both built on Volar. Two separate Volar
tsserver plugins cannot coexist in one project: the second is silently
skipped. Configure only MX's plugin and let it compose Astro's language plugin:

```json
{
  "compilerOptions": {
    "plugins": [
      { "name": "@mxlang/typescript-plugin", "astro": true }
    ]
  }
}
```

Do not also list `@astrojs/ts-plugin`. Install the optional
`@astrojs/language-server@2.16.16` peer when enabling `astro: true`.
That flag also enables `.astro.mx`: MX first lowers its template to Astro syntax,
then composes the emitter spans with Astro's TSX source map. Without
`astro: true`, `.astro.mx` files are intentionally ignored.

## In CI

`tsc` ignores `compilerOptions.plugins`, so it cannot load the plugin: a
command-line typecheck would silently miss what the editor reports. Use
`mx-tsc`, which is `tsc` with the same language plugin spliced in, and takes
`tsc`'s own arguments, output and exit codes:

```json
{ "scripts": { "typecheck": "mx-tsc --noEmit" } }
```

Astro projects use `mx-tsc --astro --noEmit` so `.astro` and `.astro.mx` files and
the MX components they import enter the same check.

The difference is total rather than partial — plain `tsc` never opens a
`.solid.mx` file at all:

```
$ mx-tsc --noEmit -p .
src/Widget.solid.mx(7,32): error TS2345: Argument of type 'string' is not
  assignable to parameter of type 'number'.

$ tsc --noEmit -p .
src/index.ts(1,23): error TS2307: Cannot find module './Widget.solid.mx' or
  its corresponding type declarations.
```

## Relationship to the language server

They do not overlap. [`@mxlang/language-server`](/editors/language-server/)
checks *MX constructs* against a host policy — a `<let>` tag where the host has
no reactive target, for example — and reports nothing about TypeScript. These
two check *TypeScript* and report nothing about host policy. Run both: an
editor can register several servers and several tsserver plugins against one
file kind, which is how ESLint and TypeScript already coexist.

## Mapping Coverage

The TypeScript plugin provides robust position mapping back to your original source:

- **Component tags and attributes:** When you pass an incorrect prop type, the error highlights the exact attribute name or value in the `.mx` or `.solid.mx` file, not a location in the compiled output.
- **Hoisted blocks:** Type errors inside `static` blocks or `import` statements are mapped correctly despite being hoisted to the top of the generated module.

### Known Gaps

- **Bare generic calls outside `${}`:** a generic call inside `${}` is fine — expressions are sliced from the source text, so `${pick<string>("lo")}` keeps its type argument verbatim. Written bare, directly as an attribute value with no surrounding `${}`, the `<` is read as the start of a tag and the expression misparses. Wrap it in `${}`.
- **Attribute-method bodies:** Method bodies on attributes (e.g., `onClick() { ... }`) are synthesized, meaning internal column mappings within the function block may be less precise.

## Composed Plugin and `astro: true`

When using the Astro host, the TypeScript plugin acts as a composed plugin. It maps `.mx` components to their underlying `.astro` JSX mappings. The command `mx-tsc --astro` runs type checking across the workspace with the Astro extensions enabled, ensuring that both `.mx` and `.astro.mx` files are correctly typed alongside `.astro` components.
