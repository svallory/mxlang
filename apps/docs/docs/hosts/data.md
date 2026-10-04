---
title: "Data target"
description: "Use a .mx file as data: parseData returns a static tree of tags, attributes and expressions for config and spec tools."
---

# Data target

The **data target** (`@mxlang/data`) reads a `.mx` file as **data**, not UI. `parseData` compiles the source and returns a static tree of what is written: tags, attributes, attribute tags, expressions with their source spans. It never renders and never evaluates. A spec tool, a config loader or a code generator walks the tree and decides what each tag means.

It is a **target**, not a host: it has no framework behind it ([Core and hosts](/architecture/core-and-hosts/)). The normative description is [specification §13.7](/specification/#137-the-data-target).

## Status: use `parseData`, not the tools

Editor and build integration for data files is deferred (TODO `data-target-tooling-dispatch`). Today:

- The language server, the TypeScript plugin, `mx-tsc`, Vite and the Bun loader do **not** compile data files.
- `mx.target: "data"` in a `package.json` is a positioned error: `mx.target "data" is not wired into the editor and build tools yet (TODO data-target-tooling-dispatch); call parseData from @mxlang/data instead`.
- `parseData` from `@mxlang/data` works on its own and is the supported entry point.

`@mxlang/data` is a private workspace package that ships TypeScript source.

## Parse a file

```ts
import { parseData } from "@mxlang/data";

const { tree, diagnostics } = parseData(source, filename);
if (!tree) {
  // One positioned error (line 1-based, column 0-based). Never a partial tree.
  console.error(diagnostics[0]);
}
```

Given a resource definition:

```mx
resource="post" table="posts"
  attributes
    attribute="title" type="string" required
  actions
    create accept=["title"]
```

`tree.children[0]` is the `resource` tag. Its `attrs` hold a `value` attribute (the default `="post"`) and `table`; its `children` hold `attributes` and `actions`, each with a `span` that slices the authored text.

## The tree

A `DataDocument` is `statements` (`import`, `export`, `static`, sorted by position) plus `children`: `tag`, `text`, `expression` (`${}`), `comment`, `if`, `for` and `const` nodes. A tag carries its `attrs`, `args`, `params`, attribute tags (`<@y>`) and `children`.

Attributes come in four kinds: `string` (a string literal), `boolean` (`required`), `expression` (`n=1`, `values=[...]`, `change=(x) => ...`, `v:=x`) and `spread`. Only a string literal is a `string`; the tree does not evaluate `n=1`.

Expressions are Marko's Babel nodes plus a printed `code` and a UTF-16 `span`. **`code` is the printed form, not the authored text; slice the source by `span` for what the author wrote.**

## What is rejected

Always rejected, each with a positioned message: `<define>` and calls to it, `<return>`, tag variables (`/v`), dynamic tags (`<${x}>`), calls to an imported component, `<!doctype>`, CDATA and XML declarations.

No data tag may be named `if`, `else`, `else-if`, `for`, `const`, `define`, `return`, `import`, `export`, `static` or `try`: core consumes those names before a target sees them. Names like `id`, `log`, `class` and `source` are ordinary data tag names.

Marko's HTML parse rules are switched off, so a tag named `source`, `input`, `title`, `script` or `pre` parses like any other tag and may have child tags. The cost: a tag-like `<name` inside a `script`, `style`, `textarea` or `title` body parses as a tag, not text.

## Options

```ts
parseData(source, filename, {
  customTags, // contract-only tags by name
  structural: "reject", // "pass" (default) | "reject"
  unknownTags: "reject", // "allow" (default) | "reject"
});
```

- **`customTags`** declares a vocabulary: required attributes, attribute types, allowed children and parents. `parseData` does not scan `tags/` or `package.json`; this map is all it knows. See [Writing a dialect package](/custom-tags/dialect-package/) for how to write and share one.
- **`structural`**: `"pass"` keeps text, `${}`, `<if>`, `<for>`, `<const>`, comments and `import`/`export`/`static` in the tree. `"reject"` makes the first of them an error, so a consumer that only reads tags and attributes cannot silently ignore an `<if>`.
- **`unknownTags`**: `"allow"` accepts a tag with no contract. `"reject"` makes it an error naming the tag, with a nearest-name hint, for a dialect that declares every tag. [Closing the vocabulary](/custom-tags/dialect-package/#closing-the-vocabulary) has an example.

`parseDataFile(path, options)` reads the file for you.
