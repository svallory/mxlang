# @mxlang/data

## 0.1.0 (unreleased)

- **Test (`mx.contracts`, decision 142):** a directly imported `ContractMap` passed as `customTags` runs the module's `analyze` under `structural: "reject"` with no scan, and is unaffected by a local `tags/` file that `getCustomTags` would pick up. The dialect-package docs page now shows both one-liners, their differences, and how to compose a dialect as one generated module.

- **Test (body whitespace, decision 141):** pins Marko-normalized spaces/tabs/CRLF and comments beside whitespace in the pass-through tree. A retained one-space text node is still rejected as text under `structural: "reject"`; dropped newline indentation is not structural text. No data-specific normalization is added.

- **Added, unstable (data-pr3, decisions 129 and 132):** the `data` target
  descriptor (`@mxlang/data/descriptor`: `name: "data"`, no host, the
  delegate-everything declarations, no `translator`, no `mappings`; the mapping
  mode is chosen in data PR 4) and `compileModule` (`src/compile.ts`).
  `compileModule` emits a TypeScript module that imports nothing and whose
  default export is the tree as a literal (`as const`) with every Babel `node`
  removed and `code`, `shape` and `span` kept; it is assignable to the new
  `SerializedDataDocument` (`@mxlang/data/tree`, arrays `readonly`). A source
  error throws one positioned `TranslateError`; its message has no
  `<filename>: ` prefix (a reporter that prints `file: message` does not
  double up). `ParseDataOptions.warnings` is a sink core fills as it raises
  warnings, so `compileModule` keeps the ones raised before an error in
  `options.warnings` (or prints them with no sink). `serializeDataDocument`
  does the strip. Importing the descriptor or calling `load()` loads no
  `@marko/compiler`; compiling does. Nothing in the tools uses it yet
  (`mx.target: "data"` end to end is data PR 4).
- **Added (data-pr1, decisions 131/132 and the 131 addendum):** the hostless
  data target. `parseData(source, filename, options?)` (and `parseDataFile`)
  compile a `.mx` source through `@mxlang/core` and return `{ tree,
  diagnostics }`: the static data tree (tags, attributes, attribute tags,
  text, `${}`, `<if>`/`<for>`/`<const>`, comments,
  `import`/`export`/`static`), fail-fast with one positioned error and no
  partial tree. Expressions are Marko's Babel nodes plus printed `code` and a
  UTF-16 `span`; text, comments, interpolations and the structural nodes
  carry the IR spans of #234 (a text node's `span` slices the authored text,
  its `value` is Marko-normalized). The data taglib neutralizes Marko's HTML parse rules on the
  19 names derived from Marko's own lookup
  (`openTagOnly`/`text`/`preserveWhitespace` to `false`), so any name may
  have child tags. `structural: "reject"` turns every structural construct
  into a positioned error for consumers that want tags and attributes only.
  `<define>` and its calls, `<return>`, tag variables, dynamic tags and
  template-tag calls are rejected; `else`, `else-if` and `try` join core's
  structural names as reserved. Ships before the target registry; the
  descriptor, `compileModule` and `mx.target: "data"` follow in later PRs.
