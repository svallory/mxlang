# @mxlang/data

## 0.1.0-alpha.1

First npm prerelease (dist-tag `alpha`), with everything listed under 0.1.0 below. `@mxlang/data` is now publishable: it builds to `dist/` with declarations (`.`, `./descriptor`, `./tree`), is no longer `private`, and depends on `@mxlang/core` at the same alpha (the `workspace:*` range is rewritten at `bun publish`) and on `@babel/types` (the shipped `tree.d.ts` imports it). Unstable API.

## 0.1.0 (unreleased)

- **Fix (unknown-order): `unknownTags: "reject"` reports an unknown parent before its children's errors.** The check now runs on a tag before anything inside it, in document order. Before, core's `parents`/`children` errors were raised during compile and won, so `resourse="post"` with an `attributes` child under it reported only `<attributes> must be inside <resource>; found inside <resourse>` and never the typo; it now reports `` `<resourse>` is not a known tag ... did you mean `<resource>`? `` at 1:0. A build or contract error that comes earlier in the file, or a known parent's `children` error positioned at the unknown tag itself, still wins; against a `structural: "reject"` hit the earlier position wins (it was always the structural hit). A `structural: "reject"` hit and a build error (a dynamic tag, a doctype) are also ordered by position now; before, the structural hit always won. The order holds inside a tag too: the structural and build walks visit a tag's attribute tags and children interleaved in source order, so the first structural hit and the first build reject are each the earliest by position (they used to walk every `<@attr>` before the children, so a later hit could win, and an unknown tag could beat an earlier dynamic tag). The tree is unchanged: `attrTags` and `children` stay separate arrays. The unknown tag is found with a parse-only pass, so a later lowering error in the file (a misused `openTagOnly`, a `<define/>`) cannot hide it. An internal (non-positioned) build error is rethrown, never replaced by the hit. Data-only, no core change.

- **Test (`mx.contracts`, decision 142):** a directly imported `ContractMap` passed as `customTags` runs the module's `analyze` under `structural: "reject"` with no scan, and is unaffected by a local `tags/` file that `getCustomTags` would pick up. The dialect-package docs page now shows both one-liners, their differences, and how to compose a dialect as one generated module.

- **Fix (zero-based-cols-in-message-text):** the `console.warn` fallback restates core's `warn` format, and printed its raw 0-based column (`page.mx:1:5`); it is now 1-based (`page.mx:1:6`), like `mx-tsc`'s `file(line,column)` and core's own fallback (ruling #227). The structured `warning.line`/`column` handed to `options.warnings` are untouched and stay 0-based.

- **Added: `unknownTags: "allow" | "reject"` on `parseData` (decision 131 addendum 3).** Default `"allow"` is unchanged. `"reject"` makes any tag, at any depth, with no entry in `customTags` a positioned error at the tag (`` `<widget>` is not a known tag: it has no contract in `customTags` ``), with a `did you mean` hint from core's `nearestName` when one declared name is clearly nearest. Reserved names and `<@attr>` tags are not checked. Found by Mesh: a typo at the top level (`resorce="post"`) passed silently.

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
