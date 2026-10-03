# `@mxlang/data`

MX's data target: a `.mx` file as **data**, not UI. `parseData` compiles a
source with `@mxlang/core` and returns a static tree — what is written,
never what it evaluates to — for consumers like spec and config tools that
walk tags and attributes rather than render them. The first consumer is the
Ash-style resource framework (mash); the fixture in
`fixtures/ash-resource/post.mx` is its resource dialect.

This package is private and ships its TypeScript source. There is no host:
`data` is a hostless target (decision 132).

## Usage

```ts
import { parseData } from "@mxlang/data";

const { tree, diagnostics } = parseData(source, filename);
if (!tree) {
  // One positioned error; there is never a partial tree.
  console.error(diagnostics[0]);
}
```

`parseData(source, filename, options?)` and `parseDataFile(path, options?)`
return `{ tree, diagnostics }`. Options:

- `structural: "pass" | "reject"` (default `"pass"`). Pass-through keeps
  text, `${}`, `<if>`/`<for>`/`<const>`, comments and
  `import`/`export`/`static` in the tree for the consumer to interpret.
  `"reject"` makes each structural construct a positioned error ("the data
  tree is static; this file's consumer does not evaluate `<if>`"), for a
  consumer that wants tags and attributes only.
- `customTags` — contract-only custom tags (decision 130): required
  attributes and attribute types, validated by core with no data-specific
  code.

## The tree

A `DataDocument` is `statements` (`import`/`export`/`static`, sorted by
position) plus `children`: `tag`, `text`, `expression` (`${}`), `comment`,
`if`, `for`, `const`. Tags carry attributes (string / boolean / expression /
bound / spread), arguments, params and attribute tags (`<@y>`, with
`<if>`/`<for>` among them kept). Expressions are Marko's Babel nodes plus a
printed `code` and a UTF-16 `span`: **`code` is the printed form; slice the
source by `span` for the authored text.**

Always rejected, each with a positioned message: `<define>` and its calls,
`<return>`, tag variables, dynamic tags, template-tag calls, `<!doctype>`.
No data tag may be named `if`, `else`, `else-if`, `for`, `const`, `define`,
`return`, `import`, `export`, `static` or `try` — core consumes those names
before any target sees them.

Marko's HTML parse rules are neutralized through the target's own taglib
(`openTagOnly`, `text` and `preserveWhitespace` to `false` on the 19 names
derived from Marko's own lookup), so a data tag named `source`, `input`,
`title` or `script` may have child tags. The trade: a tag-like `<name` in a
`script`/`style`/`textarea`/`title` body parses as a tag, not text.
