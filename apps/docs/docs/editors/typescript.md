---
title: "TypeScript"
description: "Type-check Solid, whole-file MX, and AstroMX in editors and CI."
---

# TypeScript

TypeScript cannot parse a `.solid.mx`, `.react.mx`, `.preact.mx` or `.hono.mx` module, a whole-file `.mx` / `.marko`
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

## Shorthands

A [shorthand](/language/attributes/) token (`.big`, `#main`) maps to the
generated attribute it stands for (`class`, `id`) with the token's exact source
range, so a TypeScript error on that prop is reported on the token you wrote.

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
                "languages": ["solid", "mx", "astro", "astromx"],
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

## Quick fixes

A diagnostic that knows the exact repair carries it as a *fix*: a title and the
edits that make it. The plugin answers tsserver's `getCodeFixes` request for an
MX diagnostic's range, so a client that asks tsserver for the fixes of an MX
diagnostic gets them. VS Code's TypeScript extension and `vtsls` (Zed) only ask
for the codes TypeScript itself supports, which no plugin can extend, so in
VS Code and Zed the lightbulb for an MX fix comes from the
[MX language server](/editors/language-server/), which both register for `.mx`.
`mx-tsc` prints each fix on a `fix:` line under the diagnostic, with 1-based
`line:column` positions (the end of a range is exclusive) and the new text in
quotes:

```
$ mx-tsc --noEmit -p .
page.mx(2,4): error MX_RESERVED_EFFECT_TAG: `<effect>` is not an MX tag. Use `<script>`: its body runs after render and again when a value it reads changes.
  fix: Rename to `<script>`: replace 2:4-2:10 with "script"; replace 2:17-2:23 with "script"
```

An edit is `replace L:C-L:C with "text"`, `insert at L:C "text"` or
`delete L:C-L:C`; the edits of one fix all refer to the file as it is, and a
fix applies whole or not at all. The line is the same with `--pretty`, and in
`--watch` every rebuild prints the MX errors that hold after it, fixes included.
A dialect's diagnostic carries its fixes the same way.

### What `mx-tsc` counts

An MX error (a parse or lowering error in a `.mx` file, with an `MX_` code) is
not a TypeScript diagnostic, and tsc counts only its own.

- **`--watch`.** Every rebuild prints the MX errors that hold now, after tsc's
  own errors and before the summary, and the summary's count includes them:
  `Found 2 errors. Watching for file changes.` is one tsc error and one MX
  error. An MX error you fix is gone from the next rebuild, and one in a file
  the rebuild did not touch is printed again. A `package.json` host-policy
  error (`TS80003`, such as an `mx.target` that belongs to another host) is
  treated the same: printed with every build, the first included, and counted
  in the summary. A host-policy warning is printed with every build and is not
  counted. Under `-w -p`, each `.mx` file re-resolves only its own host policy
  when it compiles, so after you change a `package.json` the TS80003 line stays
  until every `.mx` file under it has compiled again; restart the watcher to
  re-read them all. A change that breaks a `package.json` is not reported until
  a `.mx` file under it compiles.
- **One run.** The exit code is 1 when there is an MX error. tsc prints its
  `Found N errors` line only with `--pretty`, counts only its own diagnostics,
  and does not rewrite that count for MX errors, so with that line present the
  MX errors follow it and end with a count of their own:
  `mx-tsc: Found 1 MX error (tsc's own error count does not include MX errors).`
  Without `--pretty` tsc prints no count, and neither does `mx-tsc`.

## Relationship to the language server

They do not overlap. [`@mxlang/language-server`](/editors/language-server/)
checks *MX constructs* against a host policy — a `<let>` tag where the host has
no reactive target, for example — and reports nothing about TypeScript. These
two check *TypeScript* and report nothing about host policy. Run both: an
editor can register several servers and several tsserver plugins against one
file kind, which is how ESLint and TypeScript already coexist.

## `client` names

A `client` statement runs in the browser, so on the server the module that renders sees its names as `undefined` and exports none of them. The type-check follows that:

- A template read of a client name is `undefined`: `client let q = 1` then `${q.toFixed(2)}` reports `'q' is possibly 'undefined'`, and a client function or class cannot be called in the template.
- A client export is not an export of the module. `import { x } from "./ca.mx"` of a `client export const x` reports `TS2614`, from a `.mx` file (plain, `static` or `server` import) and from a `.ts` file alike. A `server` or `static` export stays importable.
- Inside client code (a handler, a `client` block, a later `client` statement) the names keep their declared types, and hover and completions show them.
- A top-level `return` in a `client` block is reported (`TS1108`) at the `return`.

Known limit: a `client import` of another module's client export reports `TS2614`, because the type-check reads that module as the server sees it.

## Mapping Coverage

The TypeScript plugin provides robust position mapping back to your original source:

- **Component tags and attributes:** When you pass an incorrect prop type, the error highlights the exact attribute name or value in the `.mx` or region (`.solid.mx`, `.react.mx`, `.preact.mx`, `.hono.mx`) file, not a location in the compiled output.
- **Hoisted blocks:** Type errors inside `static` blocks or `import` statements are mapped correctly despite being hoisted to the top of the generated module.

### Known Gaps

- **Bare generic calls outside `${}`:** a generic call inside `${}` is fine — expressions are sliced from the source text, so `${pick<string>("lo")}` keeps its type argument verbatim. Written bare, directly as an attribute value with no surrounding `${}`, the `<` is read as the start of a tag and the expression misparses. Wrap it in `${}`.
- **Attribute-method bodies:** Method bodies on attributes (e.g., `onClick() { ... }`) are synthesized, meaning internal column mappings within the function block may be less precise.

## Composed Plugin and `astro: true`

When using the Astro host, the TypeScript plugin acts as a composed plugin. It maps `.mx` components to their underlying `.astro` JSX mappings. The command `mx-tsc --astro` runs type checking across the workspace with the Astro extensions enabled, ensuring that both `.mx` and `.astro.mx` files are correctly typed alongside `.astro` components.
