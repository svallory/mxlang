# @mxlang/tree-sitter-mx

## 0.1.0-alpha.2 (unreleased)

Atoms (decision 156) and the tagless `:name=value` line. Four new local
patches, 0006 to 0009 (see `UPSTREAM.md`).

- Decision 151 ruling 2 and decision 146 addendum 5 (patch 0009): the tag's
  **default** attribute value is no longer ended at a sugar. `<if=a .b>`,
  `<if=a :b>`, `<if=foo\n  .bar()>`, `<const/x=items\n  .filter(Boolean)/>` and
  `<a=1 .d=2/>` are one value, as core reads them (member access, Marko's
  meaning), in html and concise mode; a named attribute keeps the split
  (`x=a :b`, `x=a .b`) and a bound `:=` value with no name is the default
  value too. **Except** when the default value is a single atom, where a
  following `:name` is the name sugar: `belongs-to=:Customer :customer` is the
  atom plus `name="customer"`, while `=:A.b :c` and `=:a + :b` stay one value.

- Decision 146 addendum 4 (patch 0006): `=` and `(` end a sugar and start the tag's default value: `<input #x=1/>`, `<input :x=input.y/>`, `<input:x=1/>`, `<input .c=1/>` and concise `input #x=1` parse without `ERROR` (they were errors), as Mesh's `boolean #isOverdue({ self }) { return self.x }` and `kind (p) { b } #name` already did. A bound `:=` after a sugar (`<a :n:=y/>`, `#x:=y`, `.c:=y`) stays an error: only `=` and `(` end a sugar. Scanner only; `src/` is unchanged.
  This is the line Mesh's Invoice entity uses under `set` (`:status=:sent`,
  `:needsReview=true`, `:paidById=({ actor }) => actor.id`): on 0.1.0-alpha.1
  any one of them put an `ERROR` at the root and uncoloured the rest of the file.
- Atoms (patch 0007): `:name` where an expression is expected is an `atom`
  node inside the expression node: attribute values (`default=:draft`,
  `values=[:draft, :sent]`, `x:=:a`, `...:a`), placeholders (`${:strict}`),
  tag and attribute arguments (`<if(kind === :primary)>`, `x(:a)`) and method
  bodies (`{ return self.status === :sent }`), arrow bodies and object and
  array literals included. Names may hold dashes (`:rename-all`; a trailing
  `-` is not part of the name). A `:` starts an atom only at the start of an
  expression or after an operator, punctuator or a keyword such as `return`:
  `a ? b :c` stays a ternary, `(x :number) => x` a type, `x=a :b` the name
  sugar. `a ? :b :c` is now the ternary `a ? "b" : c` (it was a value plus a
  name sugar). Never inside strings, template text, regexes, comments,
  `static`/`import`/`export` statements, scriptlets or tag parameters. A
  `${}` inside a template literal inside an expression is not scanned for
  atoms (they stay text there; README, patch 0008, TODO
  `tree-sitter-atoms-template-placeholder`).
- `::name` is one `reserved_atom` node (reserved for a `Symbol.for` sugar,
  decision 156), wherever it appears: `{k::a}` and `a?b::c` are reserved too.
  It is not an `ERROR` node and has no highlight capture; a tool that wants
  the positioned "reserved" error finds it by type.
- The injected TypeScript never sees an atom: the expression nodes are now
  rules over hidden text tokens plus their atom children, and
  `injections.scm` injects them without children. Zed's TypeScript layer sees
  a gap where an atom was; the docmd plugin parses a same-length numeric
  stand-in there (`:sent` is `0.000`), so the rest of the expression keeps its
  colours.
- Captures, for theme authors: **atoms are `@string.special.symbol`** and
  **every name-sugar form is `@label`** (`:name` tag-adjacent and in
  attribute position, `<:status=...>` included; `#id` stays `@constant`,
  `.class` `@property`). These are names Zed's themes already colour; the
  Zed extension's `languages/mx/highlights.scm` is built from this query
  unchanged.
- docmd plugin classes: `@string.special.symbol` renders as **`ts-atom`** and
  `@label` as **`ts-name`** (every other capture keeps the `ts-` + dashes
  rule). `ts-label` is gone: rename a theme rule for it to `ts-name`.

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
  (`:x=1`) is an error (0.1.0-alpha.2 lifts this, patch 0006); named modifiers (`class:x`, `style:x`, `value:fn:=x`)
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
