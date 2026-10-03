# @mxlang/data

## 0.1.0 (unreleased)

- **Added (data-pr1, decisions 131/132 and the 131 addendum):** the hostless
  data target. `parseData(source, filename, options?)` (and `parseDataFile`)
  compile a `.mx` source through `@mxlang/core` and return `{ tree,
  diagnostics }`: the static data tree (tags, attributes, attribute tags,
  text, `${}`, `<if>`/`<for>`/`<const>`, comments,
  `import`/`export`/`static`), fail-fast with one positioned error and no
  partial tree. Expressions are Marko's Babel nodes plus printed `code` and a
  UTF-16 `span`. The data taglib neutralizes Marko's HTML parse rules on the
  19 names derived from Marko's own lookup
  (`openTagOnly`/`text`/`preserveWhitespace` to `false`), so any name may
  have child tags. `structural: "reject"` turns every structural construct
  into a positioned error for consumers that want tags and attributes only.
  `<define>` and its calls, `<return>`, tag variables, dynamic tags and
  template-tag calls are rejected; `else`, `else-if` and `try` join core's
  structural names as reserved. Ships before the target registry; the
  descriptor, `compileModule` and `mx.target: "data"` follow in later PRs.
