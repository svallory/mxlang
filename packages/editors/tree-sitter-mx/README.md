# @mxlang/tree-sitter-mx

The [tree-sitter](https://tree-sitter.github.io/) grammar for MX (`.mx`), with
its highlight and injection queries, the compiled wasm, and a
[docmd](https://docmd.io/) plugin that highlights `` ```mx `` fences at build
time.

> **Beta.** This package is at 0.x. Its API may change in any release until 1.0.0.

MX is Marko's syntax plus the decision 146 name sugar (`#id`, `.class` and
`:name` anywhere in a tag) and decision 156 atoms (`:name` as a value:
`default=:draft`, `accept=[:title, :body]`, `self.status === :sent`).
Atoms are `atom` nodes inside attribute values, placeholders, tag and attribute
arguments and method bodies. One known limit: an atom inside a `${}` of a
template literal that is itself inside an expression (`` x=`a ${:c}` ``) is
not recognised and stays plain text there (TODO
`tree-sitter-atoms-template-placeholder`). The grammar is a vendored snapshot of
[`marko-js/tree-sitter`](https://github.com/marko-js/tree-sitter) with local
patches; [`UPSTREAM.md`](./UPSTREAM.md) records the pin, every patch and why.
The same grammar and `queries/highlights.scm` are what MX's Zed extension
ships.

```sh
bun add @mxlang/tree-sitter-mx      # or npm install / pnpm add
```

`web-tree-sitter` (0.26.9, exact: the wasm and the runtime must agree on the
ABI) is a dependency. The package ships `tree-sitter-mx.wasm` and the
TypeScript grammar the plugin injects; both are built when the package is
packed (`prepack`), so installing never needs a toolchain.

## `@mxlang/tree-sitter-mx/docmd`

A docmd plugin (capability `markdown`) that routes every `` ```mx `` fence
through the grammar and renders static, class-only spans. Nothing parses in the
browser. Add it to `docmd.config.json`:

```json
{
  "plugins": {
    "@mxlang/tree-sitter-mx/docmd": {}
  }
}
```

Capture names become classes by prefixing `ts-` and replacing dots with dashes
(`punctuation.bracket` is `ts-punctuation-bracket`; the grammar's `none` and
the JavaScript query's `embedded` get none), except two MX classes: an atom
(`@string.special.symbol`) is `ts-atom` and the `:name` sugar (`@label`) is
`ts-name`. The package ships no CSS: style
the `ts-*` classes in your theme. Ranges that `queries/injections.scm` hands to
TypeScript (placeholders, attribute values, `static` bodies, `import`/`export`
statements) are highlighted with the TypeScript grammar, which parses a
same-length numeric stand-in where an atom is (the atom keeps its own class); CSS and HTML
injections render as plain code text.

There is no fallback: if a wasm file is missing the module throws at import, so
a build fails instead of shipping unhighlighted code.

The module also exports the highlighter the plugin is built on:

```js
import { renderMx, spansOf, parseMx } from "@mxlang/tree-sitter-mx/docmd";

renderMx("<div.panel>${count}</div>");
// '<span class="ts-punctuation-bracket">&lt;</span><span class="ts-tag">div</span>...'

spansOf("<let/count: number = 0/>"); // [{ text, cls }, ...] rebuilds the source
```

`renderMx(source, ownerAt?)` takes an optional `ownerAt(offset)` that returns
the opening tag of a wrapper element for a UTF-16 offset, so a page can mark
regions of the example without breaking the markup. TypeScript consumers that
typecheck `node_modules` (`skipLibCheck: false`) also need `@types/emscripten`
(an optional peer: `web-tree-sitter`'s declarations use its global).

## `@mxlang/tree-sitter-mx`

The root export is the absolute paths of the artifacts, for tools that load the
grammar themselves:

```js
import { highlightsPath, injectionsPath, wasmPath } from "@mxlang/tree-sitter-mx";
import { Language, Parser } from "web-tree-sitter";

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(wasmPath));
console.log(parser.parse("<button onClick() { count++ }>${count}</button>").rootNode.toString());
```

The files are also exported directly: `@mxlang/tree-sitter-mx/tree-sitter-mx.wasm`,
`/queries/highlights.scm` and `/queries/injections.scm`.

## What is in the package

| Path | |
|---|---|
| `tree-sitter-mx.wasm` | the compiled grammar (built at `prepack`) |
| `queries/` | `highlights.scm`, `injections.scm` |
| `src/`, `grammar.js` | the generated parser and external scanner, for editors that compile the grammar themselves (Zed, Neovim, Helix) |
| `highlight/` | the docmd plugin, its `.d.mts` files, and the injected TypeScript grammar (`highlight/ts/`, built at `prepack` from tree-sitter-typescript v0.23.2 plus `extra-highlights.scm`) |

## Building from a checkout

In the [mx repository](https://github.com/svallory/mxlang), at
`packages/editors/tree-sitter-mx`:

```sh
bun run build:wasm        # tree-sitter-mx.wasm
bun run build:ts-grammar  # highlight/ts/ (needs network once: clones the pinned tree-sitter-typescript)
bun run test              # regenerates src/, builds the wasm, runs the grammar suites
```

Licence: MIT. The grammar is derived from `marko-js/tree-sitter` (JS
Foundation and contributors), see `LICENSE`.
