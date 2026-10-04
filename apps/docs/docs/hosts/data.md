---
title: "Data target"
description: "Use a .mx file as data: parseData returns a static tree of tags, attributes and expressions for config and spec tools."
---

# Data target

The **data target** (`@mxlang/data`) reads a `.mx` file as **data**, not UI. `parseData` compiles the source and returns a static tree of what is written: tags, attributes, attribute tags, expressions with their source spans. It never renders and never evaluates. A spec tool, a config loader or a code generator walks the tree and decides what each tag means.

It is a **target**, not a host: it has no framework behind it ([Core and hosts](/architecture/core-and-hosts/)). The normative description is [specification §13.7](/specification/#137-the-data-target).

## Status: `mx-tsc` checks, the editor does not yet

`mx-tsc` checks a data package. The editor tools do not (TODO `data-target-tooling-dispatch`):

- **`mx-tsc`** runs the check described [below](#check-a-package-with-mx-tsc). It is the tool for agents and CI.
- The language server, the TypeScript plugin, Vite and the Bun loader do **not** compile data files. For them `mx.target: "data"` in a `package.json` is still a positioned error: `mx.target "data" is not wired into the editor and build tools yet (TODO data-target-tooling-dispatch); call parseData from @mxlang/data instead`.
- `parseData` from `@mxlang/data` works on its own and is the supported entry point for a program.

The split is deliberate: `mx-tsc` is one command with a printed result, while editor support needs positions, hover and completion for a tree that is not UI, which is still being thought through.

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

## Check a package with `mx-tsc`

```sh
mx-tsc            # from the package directory
mx-tsc -p <dir>   # or name it
```

One command, no tsconfig. When the package's policy resolves to `data` (`mx.target: "data"` in its `package.json`, or `@mxlang/data` as the only target package in its dependencies), `mx-tsc` does not build a TypeScript program. It parses every `.mx` file under the package that the policy assigns to `data` with `parseData`, in path order, and prints each diagnostic in the compact positioned shape it uses for host files:

```text
unknown-tag.mx(1,1): error TS80001: `<servce>` is not a known tag: it has no contract in `customTags`; did you mean `<service>`?
violation.mx(1,1): error TS80001: `<service>`: missing required attribute `value`
```

Positions are 1-based line and column. The exit code is 1 when anything is an error and 0 otherwise. A clean package prints nothing.

- **The tag map** is the one the other tools scan: `tags/` sidecars and `mx.contracts` (see [Writing a dialect package](/custom-tags/dialect-package/)). A problem in the scan or in `package.json` is printed against the `package.json` (`TS80003`).
- **Defaults are strict.** `structural` and `unknownTags` both default to `"reject"` here, because an agent wants a typo or an `<if>` to fail the run. Loosen either in `package.json`: `{ "mx": { "data": { "structural": "pass", "unknownTags": "allow" } } }`. The `parseData` library API keeps its own defaults (`"pass"` and `"allow"`); only `mx-tsc` reads `mx.data`. An invalid value is an error at the value, and the strict default applies.
- **Which files.** Every `*.mx` under the directory, skipping `node_modules` and dot directories, whose nearest `package.json` resolves to `data` (a nested package for another target is left out). Other file types, including `.ts`, are not checked: use `tsc` for those.
- **Only plain runs.** `-p`/`--project` (a directory or a tsconfig path), `--pretty` and `--noEmit` are understood. Anything else (`-b`, `-w`, `--version`, a file list) is a normal `tsc` run, and a data package under it still gets the staged error above.
- A `tsc` program that spans several packages is not a data project: a data package inside it still gets the staged error. Run `mx-tsc` in the data package.

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
