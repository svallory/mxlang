# @mxlang/tree-sitter-mx

## 0.1.0-alpha.1 (2026-10-05)

First version, published as an alpha. A vendored snapshot of
`marko-js/tree-sitter` at
`7fb20382b9b0c97c8bdbceee0e0641bea11dd00f` (`@marko/tree-sitter` 0.2.0) with
two local patches (see `UPSTREAM.md`):

- Decision 146 name sugar: `#id`, `.class` and the new `:name` shorthand
  (`shorthand_name`) anywhere in a tag, tag-adjacent in any order (carrying the
  `shorthand` field) and in attribute position, first or after any attribute,
  in html and concise mode. After whitespace, `.ident` and `:ident` (with no
  open conditional `?`) end the previous attribute value. A value on the sugar
  (`:x=1`) was an error here until patch 0006 (below); named modifiers (`class:x`, `style:x`, `value:fn:=x`)
  are unchanged. `<style .scss>` (attribute position) no longer selects a
  stylesheet dialect; only the tag-adjacent `<style.scss>` does.
- The grammar is named `mx` (`tree_sitter_mx`, `source.mx`, file type `mx`),
  so it never collides with the `marko` grammar of Marko's own Zed extension.
- Publishable: `private` is gone. The tarball holds the wasm, `queries/`, the C
  sources (`src/`, `grammar.js`) and `highlight/`; `prepack` builds the wasm
  and the TypeScript grammar. Exports: `.` (absolute paths of the wasm and the
  queries), `./docmd` (the build-time highlighter and docmd plugin, moved here
  from `apps/docs/plugins/mx-highlight.mjs`, with its `.d.mts`),
  `./tree-sitter-mx.wasm`, `./queries/*.scm`. `web-tree-sitter` is a dependency;
  `@types/emscripten` an optional peer for typed consumers.
- An indented line with no tag open (a column-0 comment or tag closed the
  concise tag above) is an `ERROR` node. The scanner used to fail the lex
  silently there and tree-sitter dropped the rest of the file with a clean
  tree, where Marko reports "Line has extra indentation at the beginning"
  (patch 0004). The language rule is unchanged.
- **Fix (name-sugar-default-value, decision 146 addendum 4, patch 0006):** `=` and `(` end a sugar and start the tag's default value: `<input #x=1/>`, `<input :x=input.y/>`, `<input:x=1/>`, `<input .c=1/>` and concise `input #x=1` parse without `ERROR` (they were errors), as Mesh's `boolean #isOverdue({ self }) { return self.x }` and `kind (p) { b } #name` already did. Scanner only; `src/` is unchanged.
- The injected TypeScript highlights gain `highlight/extra-highlights.scm`:
  names bound by an object pattern (`({ self }) => ...`, a parameter or a
  `const { a } = x`) and a ternary's `?` and `:` had no capture.
- A package-specific README (patch 0005) replaces upstream's: what the package
  is, the two entry points with a docmd example, the dependency and when the
  wasm is built.
- Tests run on bun through web-tree-sitter, and compare against htmljs-parser
  fixtures pinned to v5.12.0 instead of its unpinned HEAD.
- Tag-param patterns/types/defaults, tag-var types and type arguments start at
  their first character and end at their last (no whitespace around them), so highlight
  captures cover `number`, not `" number"`. An attribute's `=` and `:=` are
  `@operator` and its value `@none`.
