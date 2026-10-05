# @mxlang/data

## 0.1.0-alpha.4

- `unknownTags: "reject"` counts a child claimed by a parent's `children["*"]` as known, on the build path and on the parse-only scan used when core reports an earlier error (decision 147).
- `<let>`, `<style>` and the other core-taglib names are never claimed by a wildcard, like every target (decision 147 addendum 2).
- **Added: atoms in `parseData` (decision 156).** An attribute whose whole value is one atom, the sugar-derived `name` included, is `DataAttr { kind: "atom", name, value, nameSpan?, span }`; an atom nested in an expression is a `StringLiteral` with `extra.mxAtom = { span }` in `DataExpr.node`. Atom contracts (`type: "atom"` with `values`, `pattern`, `ref`, and `declares`) are checked; see `@mxlang/core` 0.1.0-alpha.4.
- **Added:** a sugar after a single-atom default value (`belongs-to=:Customer :customer`, decision 146 addendum 5) and a sugar followed by `=value` or `(params) { body }` (decision 146 addendum 4) parse on the data target.
- **Fixed:** shorthand attributes carry a real `nameSpan`.

## 0.1.0-alpha.3

- **Changed (decision 159):** `@marko/compiler` is no longer a dependency. The scan and the data taglib use `@mxlang/core`'s `markoCompiler()`, so data parses with core's bundled Marko front end and MX's own template parser: after-value sugar (`<field type="email" :email/>`) works in a registry install. Requires `@mxlang/core` 0.1.0-alpha.3.

## 0.1.0-alpha.2

2026-10-05. Identical to alpha.1; republished because the alpha.1 tarballs lacked `dist/` when installed by Bun. No code change.

## 0.1.0-alpha.1

First npm prerelease (dist-tag `alpha`), with everything listed under 0.1.0 below. `@mxlang/data` is now publishable: it builds to `dist/` with declarations (`.`, `./descriptor`, `./tree`), is no longer `private`, and depends on `@mxlang/core` at the same alpha (the `workspace:*` range is rewritten at `bun publish`) and on `@babel/types` (the shipped `tree.d.ts` imports it). Unstable API.

## 0.1.0 (unreleased)

- **Fix:** a shorthand attribute (`#id`, `.cls`) now carries its `nameSpan` (sigil plus token) in the tree; it was omitted while core gave it `NaN` offsets. The field stays optional in the type.
- **Feat (name-sugar-default-value, decision 146 addendum 4):** Mesh's `boolean #isOverdue({ self }) { return self.x }` is a `boolean` tag with `id="isOverdue"` and a function `value` (concise, html, child line, either order of the params); `#x=1`, `:x=input.y`, `.c=1` give the sugar plus `value`; a `value: function` contract passes it and E1 on it is positioned at the sugar's value.

- **Docs/Tests (name-sugar-tooling, decision 146 PR 3):** the README documents `:name` for Mesh (`<attributes><:title type="string"/></attributes>` is `<attribute name="title" type="string">`) and E1 naming the token; tests pin the HTML and concise forms and the E1 messages and positions.

- **Fix (name-sugar-core, Mesh):** a valueless modifier attribute (`x:foo`, `value:foo`) no longer trips "core IR invariant broken — static attribute … carries no span" under `structural: "reject"`; core gives it a zero-width `valueSpan`. `<:title/>` resolves to the target's `object` tag with `name="title"` and `entity :Todo table="todos"` is `name="Todo"` (decision 146, `@mxlang/core`).

- **Docs (default-tag-docs, decision 145):** the README documents the built-in `object` tag, `mx.data.defaultTag`, the ladder and the Mesh example (`<attributes><#title type="string"/></attributes>` with `attributes` declaring `defaultTag: "attribute"`).

- **Fix (default-tag-contracts r3):** when an invalid contract `defaultTag` falls through, the E2 at the use site says so.

- **Fix (default-tag-contracts r2):** an invalid contract `defaultTag` falls through to `mx.data.defaultTag`/`object` instead of erroring at every use; control flow between the parent and the shorthand is seen through.

- **Added (default-tag-contracts, decision 145):** a parent contract's `defaultTag` resolves the unnamed tag before `mx.data.defaultTag` and `object`: `<attributes><#title type="string"/></attributes>` with `attributes` declaring `defaultTag: "attribute"` is `<attribute id="title" type="string">`, with E1/E2 positioned at the shorthand.

- **Added (default-tag-ladder, decision 145):** the built-in `object` tag, the data target's `defaultTag`: the anonymous node the unnamed tag (`<#id>`, `<.class>`) resolves to, carrying `id`/`class` as ordinary attributes. Always known (never an unknown-tag error under `unknownTags: "reject"`), no contract needed, replaceable by a declared `object`; a closed parent `children` that lists neither `object` nor a default gives the ordinary E2 error. `ParseDataOptions.defaultTag` (`mx.data.defaultTag`) makes the shorthand that tag with its contract applied (E1 for `class`/`id` when its attributes are closed); the parse-only scan names the shorthand the same way (it read Marko's `div` before). The descriptor declares `defaultTag: "object"` and a lazy `parseTranslator`.

- **Feat (default-tag-core, decision 145):** declares `resolveDefaultTag: () => "div"`, the interim answer for the unnamed tag until the registry ladder lands. Output is byte-identical.

- **Fix: a registration error with no source position is a file-level diagnostic.** A `customTags` registration error (for example a `finalize`-only declaration, a contradictory attribute declaration, an unknown key in a `children` declaration) comes from core at 0:0. `parseData` now reports it at `line: 1`, `column: 0`, `offset: 0` instead of `line: 0` and `offset` equal to the source length, so `DataDiagnostic.line` stays 1-based. A warning at 0:0 gets the same treatment, and the caller's `warnings` array is not mutated. The message is unchanged; a diagnostic with a real position is untouched, and one in another file keeps `offset: -1`.

- **Fix (proto-names): a data tag named `toString`, `constructor`, `hasOwnProperty`, `valueOf` or `__proto__` is an ordinary tag.** `parseData` threw a raw `TypeError` from Marko for these names in both `unknownTags` modes. They now parse to a data tag under `"allow"`, get the normal unknown-tag error under `"reject"`, and a `customTags` entry of that name is a contract. The fix is in core, plus the same prototype-stripping on the parse-only scan's own lookup (`scan.ts`), so `unknownTags: "reject"` still reports an unknown prototype-named parent above a contract error on a cold Marko cache.

- **Fix (body-beside): a comment before an attribute tag is a child comment, not a `""` attribute tag.** `<loose>\n  <!-- c -->\n  <@m>t</@m>\n</loose>` gave an `attr-tag` named `""` with a non-finite `nameSpan` and lost the comment. The fix is in core (`lowerAttributeTags`); the tree now carries the comment in `children`, and `structural: "reject"` reports it like any comment. `dataAttrTag` also refuses a non-finite `nameSpan` with a named invariant error. Text and tags beside an attribute tag already stayed in `children`; regression tests pin that, in HTML and concise mode.

- **Fix (marko-parity-trio):** `parseData` now reports the same two `<for>` diagnostics every other surface does — a string `by=` outside `of=` and a `key=` on `<for>` — because both come from core's lowering, which this target shares. Data-only, no core change.

- **Fix (empty-declaration): `customTags: { pub: {} }` is a valid contract.** `parseData("resource\n  pub", ...)` with `pub: {}` (and `resource: { children: { pub: {} } }`) under `structural: "reject"` and `unknownTags: "reject"` now gives a tree and no diagnostics, instead of "custom tag has neither a `transform` nor a template file". The same holds for an `mx.contracts` module entry. The fix is in core (`isContractOnlyDelegated`); data has no code change.

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
