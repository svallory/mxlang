# @mxlang/data

## 0.1.0-alpha.13 — 2026-10-09

- **Added (lang-ext-lowering-half):** Layer-2 syntax modules (decision 182 addendum 5). `package.json#mx.syntax` may name a module (a package name or a path relative to the manifest, resolved like `mx.contracts`) whose default export is a `SyntaxModule`: `{ table, lowerTrigger?, lowerBlockTag?, lowerFilter?, afterLower?, productName? }`. The `syntax` option of `compileSource`, `parseFragment` and `parseData` takes a module too. An inline `mx.syntax` stays table-only: a `{ call }` trigger there, or in a module that exports no `lowerTrigger`, is an error at the `mx.syntax` key. Triggers lower before anything reads the tree. An expression trigger's stand-in becomes the node `ctx.expression(node)` carries, and the expression's emitted `code` carries that node printed (`&status` becomes `self.status`), as it carries an atom's string literal. An attribute trigger becomes the attribute `ctx.attribute(name, value)` builds. A tagless-line trigger becomes the child tag `ctx.child(tagName, attrs)` builds, which then goes through the normal tag path. `ctx.position` and `ctx.value` (the lowered `=value`) are read-only. The built-in node kinds (`"string"` and `"identifier"` in expressions, `"attribute"` in attribute lists) lower without a hook. Block tags and filters go to `lowerBlockTag`/`lowerFilter` with `ctx.build`. Positioned errors cover a result that does not fit its position, a hand-made result, a hook that throws, a `=value` the hook drops, a trigger in binding position (`(&a) => 1`), a trigger as a property name (`{ &a }`, `{ &a: 1 }`), a `ctx.expression` node that is not an expression, and a built-in kind in a position where it has no meaning. A `{ call }` trigger nothing lowers keeps "`<id>` trigger has no lowering yet". New IR: `Member`, `MxMemberMark`, and `member?` on a static `Attr`. New contract type `type: "member"`: it accepts a member in either form, the static value after a kind or a dynamic value that is exactly one marked member (`load=&visible`). An `"expression"` slot accepts a member too, an `"atom"` slot refuses both forms ("must be an atom, got a member"), and `values`/`pattern`/`ref` stay atom-only. A second member in one name slot (`sort asc &c &d`) is a positioned error ("one member per slot"), not a dropped duplicate. `@mxlang/data`'s `DataAttr` gains the variant `{ kind: "member"; name; value; nameSpan?; span }`, a sibling of the atom variant.

- **Changed (port-pr5-mx-path):** `compileSource`, `parseFragment` and `parseData` (its compile and its `unknownTags: "reject"` tag scan) now parse with the MX front end (`@mxlang/parser/frontend`, inlined into core's dist) instead of `@marko/compiler`: no production call site parses through `@marko/compiler` any more, which stays only as a test oracle; `parseFragmentNative` now delegates to `parseFragment`. New `parseMxDocument` (`@unstable`, for data's scan): a file's MX document as `compileSource` parses it, without lowering, or `undefined` when the template does not parse. One parse per compile: the syntax-table pre-pass is gone, and its "`<id>` trigger has no lowering yet" error comes from the compile's single document. `FragmentResult.body` is the MX body and `FragmentResult.ast` the `MxDocument`; an expression error in a fragment stays on its container and is raised by `lower`, and `parseFragment` throws for the same inputs as before (a template error, a bare `,` line, a method's type-parameter error). Host hooks (`resolveDelegatedTag`, `rejectModifier`, `resolveDefaultTag`, …) still receive Marko-shaped nodes, now a read-only view of the MX node. Error text and positions are unchanged, with one exception: the `CompileErrors` aggregate message is Node's form on every runtime (no Bun/JSC stack frames inside `@marko/compiler`). Removed: decision 151's stock-parser diagnostics (a stock `htmljs-parser` never parses MX input).

- **Fixed (tree-conformance-grammar-corpus):** `parseData` rejects a shorthand id or class with a placeholder (`<x#a${y}/>`, `<x.a${y}/>`) with an error positioned at the sigil, instead of `internal error: … core IR invariant broken — attribute `id` carries no span` (id) or a wrong "together with a `class` attribute" message (class). The grammar package gains `test/corpus/`, 314 tree-sitter corpus cases (htmljs-parser v5.12.0 fixtures the grammar accepts, plus MX's own), and a data-target test that runs every case through `parseData`.

- **Added (tree-imports-parsed):** Each `DataDocument.imports` entry now carries `from` (the module specifier) and `names` (`{ imported, local, kind: "default" | "named" | "namespace" }`, with `typeOnly: true` on a name written `{ type X }`) beside `code` and `span`, plus `typeOnly: true` on a whole `import type`. They are read from the Babel `ImportDeclaration` the MX front end parsed, never from the statement text. To carry it, core's `Import` IR node gains an optional `declaration` (the parsed `ImportDeclaration`, as the author wrote it: type-only marks included, although the compile strips them from the payload before lowering); it is absent on a synthesized import. An `import` that is not one ES import declaration (`import x = …`, several statements in one `import`, Flow's `import typeof`) is now a positioned error at the statement on every target (decision 193); `import x = require("y")` no longer shows Babel's CommonJS advice.

## 0.1.0-alpha.12 — 2026-10-09

- **Added (lang-ext-syntax-table-parser-c):** `package.json#mx.syntax` (decision 182, PR C): core resolves a file's syntax table from its nearest manifest (a dependency's files use the dependency's manifest), overlaid on the `.mx` default row, validated with positioned diagnostics at the manifest's `mx.syntax` key (`tagTypes` is refused: tag types are taglib-owned), frozen and interned by hash. `compileSource`, `parseFragment` and `@mxlang/data`'s `parseData` accept an explicit `syntax`. Core lowers no trigger yet: a file whose table produces a trigger, block tag or filter fails with one positioned error ("`<id>` trigger has no lowering yet"), and a project on the default row runs no extra parse. New exports: `SyntaxTable`, `Trigger`, `StandIn`, `TriggerNode`, `SyntaxDiagnostic`, `defaultSyntax`, `normalizeMxSyntax`, `resolveSyntax`, `syntaxHash`.

- **Changed (release-changelog-in-package):** `CHANGELOG.md` is now part of every published tarball (`files` lists it in all packed packages); `bun pm pack` honours `files` only, so the alpha.11 tarballs carried just `README.md` and `dist`.

- **Fixed (tree-reject-invalid-tag-names):** A tag name outside letters (any script), digits and `-._:$` (`&title`, `a!b`) is now a positioned error on the name ("Invalid tag name `&title`; Marko rejects it too — …"), next to the existing attribute-name error, on every target. Stock Marko lexes such a name and fails only later in its translator ("Unable to find entry point for custom tag"); `parseData("div\n &title\n")` used to return a child tag named `&title` with no diagnostic.

## 0.1.0-alpha.11 — 2026-10-09

- **Fixed (tree-comments-not-structural, decision 131 addendum 5):** comments are never structural. Under either `structural` value a `//` line or `<!-- -->` stays in the tree as the `Comment` node it already is under `"pass"`; `structural: "reject"` no longer reports it and keeps rejecting `<if>`/`<for>`/`<const>`, `${}`, `export`/`static`, and `import` unless `imports: "pass"`. `mx-tsc`'s strict data check inherits the fix. No new option.
- **Added (data-attribute-tags-wildcard):** depends on `@mxlang/core` with `attributeTags["*"]` (decision 147 for attribute tags): `parseData` validates a wildcard-matched attribute-tag name against the matched entry's inline contract, the same as an explicit entry, and leaves an unmatched name the usual unknown-attribute-tag error. No change to the data target's own code.
- **Fixed (`data-transform-output-tree`):** a declared tag's `transform` output reaches the tree through `parseData`. Built tags that carry spans (built `from` a source with a name span — see `@mxlang/core`'s `from` on builders) are projected like authored tags, their positions taken from the source they were built from, and an unknown-tag or build error on a built node points there instead of the call. A built tag whose `from` carries no name span still hits the internal `carries no span` invariant — there is nothing to point at. No change for tags without `transform`.

- **Changed (rename-data-target-to-tree):** **BREAKING (decision 187):** the registered target name `"data"` is now `"tree"`: `mx.target: "tree"` selects it, a third-party host declares `builtOn: "tree"`, and every diagnostic names `tree`. The literal `"data"` is reserved for the future evaluated tree target and is refused with a positioned error (`"data" is reserved for the evaluated tree target (decision 187); the static tree target is "tree"`), under `mx.target` and `builtOn` alike. `mx.data.*` config is unchanged — including `defaultTag` (`mx.tree.*` is read by no tool) — and the package name stays `@mxlang/data` (`parseData` keeps its name).

## 0.1.0-alpha.10

- Depends on `@mxlang/core@0.1.0-alpha.10`, which restores body text after Unicode whitespace followed by `//` (a regression in alpha.7 to alpha.9), makes the parser's non-ASCII word class exact and removes a parser throw on a nameless tag. No change to the data target's own code.

## 0.1.0-alpha.9

- **Added:** a bound attribute (`kind: "expression"`, `bound: true`) carries `refinement?: DataExpr`, the `fn` of `v:fn:=q` (Marko's change-handler function; `node: null`, `span` slices the modifier). Absent without a modifier.

- **Note (data-check-keys-on-base-target):** a third-party host built on data declares `builtOn: "data"` on its descriptor to inherit data's `mx-tsc` check (strict defaults and `mx.data.*`); reusing `dataDeclarations` alone does not.

- **Changed (statement-tags, decision 168):** the data compile passes `statementTags: false` to core, so core's six statement tags are not registered beside the data taglib's own three; `class` stays an ordinary data tag name. No output change.

- **Fixed (main-differential-crashes):** a top-level concise line holding only `,` is a positioned error from core, not an uncaught `TypeError`; the data target now has a test for it (no code change here).
- **Changed (decision 162):** `parseData` reads core's `errors` list, so independent errors of one file (a scriptlet, a tag outside its parent, a CDATA section) are all diagnostics, once each, in position order.

## 0.1.0-alpha.8

- **Changed: `parseData` reports every error of a file and never throws.** `diagnostics` already was an array; it now holds one positioned error per independent mistake, earliest first (same message at the same place once): every syntax error Marko's parser recovers from (its `CompileErrors` aggregate used to escape as a raw throw), and, once the file lowers, every build reject (dynamic tag, tag variable, `<!doctype>`, merged shorthand class, ...), every `structural: "reject"` hit and every `unknownTags: "reject"` tag. Core's lowering still stops at its first error, so a lowering error (`parents`/`children`, a bad attribute) is the one error of its kind; the unknown tags are still listed beside it. An error with no source position (a bug in this package or core, e.g. `core IR invariant broken`) used to be rethrown; it is now an error diagnostic at 1:0 whose message starts with `internal error: `. An error inside an unknown tag's element is kept and suffixed `(inside the unknown tag `<x>`; may resolve once it is declared)`, never dropped; two different errors at one position both stay (only an identical file/position/message is deduplicated). A Marko error with a label but no position is prefixed `unpositioned error: ` instead of `internal error: `. A file with a single error, and a clean file, return exactly what they did. `buildDataDocumentAll` is the new collecting build; `buildDataDocument` still throws the first error. Result shape unchanged.

- **Added:** `parseData` option `imports: "pass" | "reject"` (default: the effective `structural` value). With `structural: "reject"` and `imports: "pass"`, control flow, `export` and `static` stay rejected and the tree gains `imports: DataImport[]` (`{ code, span }`, each top-level `import` verbatim, file order, UTF-16 spans); those imports leave `statements`. `structural: "pass"` with `imports: "reject"` rejects only imports. `DataImport` is exported; additive.

- **Changed (types only):** `DataExpr.node` is `Expression | null`, following core's `Expr.node: Node | null`. An authored expression always has a node; one core built itself has `null`. Narrow before reading it.

## 0.1.0-alpha.7

- Depends on `@mxlang/core@0.1.0-alpha.7`: the template parser no longer throws on a stray closing tag after a nameless concise tag, and Unicode whitespace behaves as ASCII whitespace in every look-behind. Two behaviour changes for input containing Unicode whitespace are listed in core's changelog. No change to the data target's own code.

## 0.1.0-alpha.6

- Depends on `@mxlang/core@0.1.0-alpha.6`: non-ASCII identifiers before `/` and before keywords parse correctly, Unicode whitespace before an atom's `:` behaves as a space, and a comment in a text tag's open tag no longer crashes the parser. No change to the data target's own code.

## 0.1.0-alpha.5

- Built on `@mxlang/core` 0.1.0-alpha.5: `parseData` no longer lexes an atom after a non-ASCII identifier where TypeScript owns the colon (`x=({ é:a })`), a silent meaning change in alpha.4 (decision 156 addendum 9).
- **Added:** `parseData` option `imports: "pass" | "reject"` (default: the effective `structural` value). With `structural: "reject"` and `imports: "pass"`, control flow, `export` and `static` stay rejected and the tree gains `imports: DataImport[]` (`{ code, span }`, each top-level `import` verbatim, file order, UTF-16 spans); those imports leave `statements`. `structural: "pass"` with `imports: "reject"` rejects only imports. `DataImport` is exported; additive.
- **Added (third-party-data-host, decision 148):** the data declarations list `builtinTags: ["object"]`, so a third-party host built on data (Mesh) that reuses them keeps `object` as its `defaultTag` and may override it per the decision 145 ladder.

## 0.1.0-alpha.4

- **Feat (wildcard-children-data, decision 147):** a tag claimed by a parent's `children["*"]` entry keeps its authored `name` and gains two optional fields, `contract` (the canonical tag whose contract applied; equal to `name` for an inline contract) and `groups` (the pattern's named captures, omitted when empty). `SerializedDataDocument` and `compileModule`'s emitted literal follow; every tree without a wildcard match is byte-identical. `mx-tsc` host-dispatch rows `data-wildcard`, `data-wildcard-nomatch` and `data-wildcard-guard` pin the data check.
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

- **Fix (statement-tag-name-sugar):** `<root><import:x/></root>` is a positioned diagnostic, not the internal error "@mxlang/data: unexpected IR node kind `Import` in a body" (and the same for `<export:x/>` and `<static:x/>`). A `:name` sugar on a statement tag is rejected by `@mxlang/core` on the colon; the diagnostic names the statement tag. `<a.${x}/>`, the dynamic shorthand class, builds a tree (the `class` expression carries its `nameSpan`); pinned after the shorthand `nameSpan` fix.

- **Fix:** a shorthand attribute (`#id`, `.cls`) now carries its `nameSpan` (sigil plus token) in the tree; it was omitted while core gave it `NaN` offsets. The field stays optional in the type. A **dynamic** tag-adjacent shorthand (`<a.${x}/>`) carries the same span — the sigil and the whole `${…}` — not the expression alone.
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
