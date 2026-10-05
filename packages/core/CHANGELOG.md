# @mxlang/core

## 0.1.0-alpha.1

First npm prerelease (dist-tag `alpha`), with everything listed under 0.1.0 below. `@mxlang/core` is no longer `private`; `exports["."]` now carries a `types` condition so a `moduleResolution: bundler` consumer finds `dist/index.d.ts`. No code change. Unstable API.

## 0.1.0 (unreleased)

- **Fix (html-imported-return-tag-object-object):** an imported `.mx` tag that declares `<return>`, called without `/var`, now lowers with `returnsValue` on its `Component` node, like a discovered template call, so the emitters unwrap `{ value, output }` instead of concatenating the pair (`[object Object]` on `@mxlang/html`, a dropped object on the JSX hosts). New `calleeReturnsValue(target, ctx)` in `callee-input.ts` reads the callee's cached template metadata through the same resolution `readCalleeInput` uses; it is false for a `.ts` module, a barrel re-export, an unresolved specifier, a host module file and a unit still mid-compile. `/var` on an imported call is still rejected. A dynamic tag or `.ts` barrel route to such a unit is a documented gap (`divergences.md`).

- **Feat (name-sugar-core, decisions 146 and 151):** `:name`, `#id` and `.class` sugar. `:val` sets `name="val"` as `#val` sets `id` and `.val` sets `class`, tag-adjacent (`<input:email>`, `<a.c:b#d>`, `<:email>` = the unnamed tag, decision 145, with `name="email"`), first in the attribute list and after any attribute (`<input type="email" :email>`). New `name-sugar.ts` rewrites the parsed tree once per tag, in the `resolveUnnamedTags` walk, before a tag name is read: a static tag name splits at its first `:`, the static part of the shorthand `class`/`id` values splits the same way (a dynamic shorthand only its static tail), and attributes named `#x`, `.x`, `:x` (and `.c:y`, `#d:y`) become `id`, class and `name` before the shorthand merge, so `<div.a #m .b>` is `<div.a.b#m>`. A sugar attribute reports its whole token as `nameSpan` and the identifier as `valueSpan`. Errors, all positioned: a second `:` in the tag head, a value on the sugar (`:x=1`), a token that is not an identifier. Untouched: the named forms (`class:x`, `style:x`, `value:x`, `value:fn:=x`), a bare `:`, dynamic tag names, attribute tags (`<@svg:rect>`), bound attributes, and every tag on a host with `acceptsForeignAttrNames` (core names no host). **Breaking, four `divergences.md` rows:** a tag name cannot contain `:`; bare `:x` is `name`, not Marko's `value:x` (write `value:x`); the parser after-value rule; a shorthand class/id cannot contain `:` (write `class="hover:x"`).

- **Feat (name-sugar-core, decision 151 ruling 1):** a consumer on a stock `htmljs-parser` gets a positioned error for `:name` after an attribute value instead of Marko's "exactly one expression" failure. `stock-parser.ts` probes the parser `@marko/compiler` resolves, once per process; `compileSource` and `parseFragment` throw a `TranslateError` that names the rule, says these positions need the patched parser and points at `<input:email type="email">`. `x=a.b .c` stays silently member access on a stock parser (not detectable). The `htmljs-parser` patch (`patches/htmljs-parser@5.15.0.patch`, repo-only) now exempts the default attribute (`<if=a .b>`, `<const/x=…\n  .filter()/>` keep Marko's meaning).

- **Fix (name-sugar-core, Mesh):** a valueless colon-named attribute (`x:foo`, `x:`, `value:foo`) lowers to a static attribute with a zero-width `valueSpan` at the end of its name. It had none, so `parseData('entity value:Todo …', …, { structural: "reject" })` threw "core IR invariant broken — static attribute … carries no span". (The Mesh spelling `entity :Todo` is `name="Todo"` since the sugar.)

- **Fix (default-tag-contracts r3):** `TargetHost.allowContractDefaultTag` (added earlier in this series, unreleased) is removed: the permit flag has one source, the target's declarations (`HostDeclarations.allowContractDefaultTag`), read by registration and by every compile. New: `CORE_TAGLIB` (Marko's core tags, moved here from `@mxlang/html`'s `taglib/marko.json`: one copy) and `judgingLookup`, which keeps it behind every lookup a default tag is judged in, so `else-if`, `html-script`, `html-style`, `html-comment` are never native custom elements on a host whose translator has no core taglib. An unnamed tag whose parent contract's `defaultTag` was invalid and fell through carries the hint "(the parent's `defaultTag` `x` is invalid; see the declaration)" in a use-site E2.

- **Feat (default-tag-contracts r2):** a dashed custom-element name (`sl-card`) is a valid `defaultTag` (`DefaultTagScope.isNativeElement`, `isCustomElementName`) exactly where the host compiles an unknown dashed name as a native element: the host's own `isElement` answers, no host name in core. Marko core tags and non-dashed unknown names stay rejected.

- **Fix (default-tag-contracts r2):** the contract-parent lookup sees through `if`/`else-if`/`else`/`for` (`CONTROL_FLOW_TAGS`, shared with the lowerer) and core-owned `try` before consulting a lookup's tag def, so it works on every target; `contractDefaultTag(parents, context, builtins)` takes the resolver's `DefaultTagContext` and returns `undefined` for a value `validateDefaultTag` rejects (an invalid contract value falls through to the next rung) or when the host forbids the rung (`HostDeclarations.allowContractDefaultTag: false` -> `context.contractRung: false`). `DefaultTagContext` gains `contractRung` and `scope`; a compile with no Marko lookup judges default tags in Marko's own element taglibs. `ownDefaultTag` also runs the contracts' registration check for entries that scan for themselves (`tags`, `hostName`).

- **Feat (default-tag-contracts, decision 145):** `defaultTag` is a declaration key beside `children` in sidecars and `mx.contracts`, top level and on attribute-tag declarations at any depth; a value that is not a non-empty string is a registration error naming the owner chain. New exports: `contractDefaultTag(parents, customTags)` (the nearest authored parent's declaration, structural parents skipped by Marko's tag def, an attribute-tag parent reads its declaration in the owner's `attributeTags`) and `contractDefaultTagDiagnostics`. `CustomTag.defaultTag`, `CustomTagAttributeTag.defaultTag`, `DefaultTagParent.tagDef`.

- **Fix (default-tag-ladder r3):** an element is a valid `defaultTag` only when the host's `isElement` says so and Marko's tag def carries its `html` flag (a taglib property), so a casing-only host (Solid) and a target with no declarations no longer accept `await`, `try`, `define` or `effect`. A failed scan makes the custom tags unknown (`customTagsUnknown`, `defaultTagScopeFor({ customTags: () => … })`): the parse-shape check still runs and a verdict that needs the custom tags is skipped; any other failure building the scope throws.

- **Fix (default-tag-ladder r2):** `checkConfiguredDefaultTag`, `ownDefaultTag`, `defaultTagDiagnostic` and `defaultTagScopeFor` are the one read-then-validate path every compile entry shares; a scope that throws (a malformed `mx.contracts`) skips the reachability check instead of escaping from a policy call. `validateDefaultTag` takes `isElement`, so core and translator tags (`await`, `try`, `define`, `effect`) are no valid built-in, and a target with no elements (data) answers parse shape only. A shorthand attribute's contract error (E1) is positioned at its tag, not 0:0. The descriptor error names what `defaultTag` is for.

- **Feat (default-tag-ladder, decision 145):** every target descriptor declares a required `defaultTag` (`validateDescriptor`, `createTargetLookup` and the third-party loader refuse a descriptor without a non-empty string, positioned at the `mx.target`/`mx.host` value); `TargetHost` gains an optional `defaultTag` override and an optional `allowContractDefaultTag` (default true), and descriptors an optional `parseTranslator`. The target policy reads `mx.<target>.defaultTag` (`TargetPolicy.defaultTag`, `defaultTagAt`, `descriptorAt`, `PolicyLocation`); any non-string or empty value is one `invalid-default-tag` diagnostic positioned at the value, and `readTargetDefaultTag` reads another target's key. `resolveDefaultTag` receives a third argument, `DefaultTagContext` (`configured`, `customTags`); the configured name travels as `HostOptions.defaultTag`, `Ctx.defaultTag`, `TargetCompileOptions.defaultTag` and `HostRegionInput.defaultTag`. New: `validateDefaultTag` (is a name a reachable, plain-parsing tag, read from the lookup's own `parseOptions`) and `buildMarkoLookup`; `resolveTargetPolicyDetailed` takes `{ quiet }`. Core names no tag.

- **Feat (default-tag-core, decision 145):** the unnamed tag (`<#id>`, `<.class>`, concise `#id`/`.class`) is no longer silently `div`. Core recognises it by its empty name span and calls the new optional `HostDeclarations.resolveDefaultTag(node, parents)` once per unnamed tag; the answer lowers like an authored tag of that name. New export: `DefaultTagParent`. Without the hook the shorthand is a positioned `TranslateError`. No behaviour change for any host that answers `div`.

- **Fix (astro-fence-top-level-return):** `checkReservedSource` takes an optional fourth argument carrying `allowReturnOutsideFunction`, for authored source a host compiles inside a function body (Astro's `---` frontmatter), where a top-level `return` is legal. The default is off, so Marko statement tags and every other caller keep rejecting a stray `return` in real module scope. Core stays host-agnostic (decision 126): the host states the fact about its own grammar, and the reservation check itself is unchanged — `__mx*` bindings are still rejected inside such a fence. New export: `CheckReservedSourceOptions`.

- **Fix (reserve-mx-identifiers):** reject authored `__mx*` bindings, including destructuring, tag parameters and parsed statements, at the authored identifier. Host code regions share the check and actionable diagnostic; property keys and references remain legal. New exports: `checkReservedBindings`, `checkReservedSource` and `reservedBindingMessage`. Statement tags are reparsed with Marko 6.3.51's own plugin list (decorators included), so a decorated `static @d() class C {}` is checked rather than skipped; a tag that still fails to parse is skipped, never rejected. Type-only names — type parameters and `declare function` parameters — stay legal, since no emitted binding can collide with them. This is intentionally stricter than Marko 6.3.51.

- **Fix (translate-error-callee-file):** callee-template parse failures now carry the template's path and coordinates on the existing `TranslateError` fields, including through nested template calls. Marko aggregates retain all frames at their first parser error's position, without repeated path headers or compiler stacks. Scan errors carry sidecar/manifest paths structurally, without repeating them in the message. No new fields or exports.
- **Fix (attr-value-parity review):** classify builtin value syntax independently of host rendering disposition, including HTML's delegated `<let>`. Native guards reject functions/symbols with Marko debug text; spread guards reference the once-per-module value helper. Remove the unused public guard-body export.

- **Fix (attr-value-parity):** validate builtin duplicate values before a host drops or claims the tag. `<let>`/`<return>` use Marko 6.3.51's duplicate-value text at the second value; `<const>`/`<id>` retain their linked tag-specific diagnostic at the tag name. Delegated vocabulary retains ordinary attribute normalization. Export host-neutral, inlinable native-attribute coercion helpers; class/style and controlled writers are exempt.

- **Fix (colon-attr-followups round 2):** every non-reserved colon name (`x:foo`, `data:x`, `attr:x`, etc.) is ordinary and retains its complete spelling; only native `class:`/`style:`/`on:` prefixes reach modifier hooks. Ordinary native colon-name methods and function values now report Marko's exact function diagnostic before argument diagnostics, at the authored attribute name. Component callable props and event attributes retain their existing policies.

- **Fix (colon-attr-followups):** reject non-reference bound attributes at Marko's value position on dynamic tags, ordinary components and built-in controls, including controls containing attribute tags, before any attribute can be silently discarded. Registered custom-tag and attribute-tag contracts keep decision 138's bound-literal checks. Preserve empty modifiers on ordinary names (`x:`), including static, dynamic and valueless attributes; reserved `class:`, `style:` and `on:` still reject and event suffixes are not dropped.

- **Fix (marko-parity-trio review):** preserve the empty `:` shorthand as `value:` and explicit last-colon names such as `value:foo:bar`; attribute-name spans measure the spelling actually authored. Arguments on these ordinary attributes report Marko's full-name error (``Unsupported arguments on the `value:foo` attribute.``) at the attribute. A non-reference native-element `:=` target, including `<div :="x"/>`, now reports `Attributes may only be bound to identifiers or member expressions` at the value instead of silently emitting only the initial value. Identifier and non-private member targets (including optional members) keep their existing host-defined binding behavior; custom-tag and attribute-tag contracts keep their E1 bound-value checks (including literal arrays).

- **Fix (proto-names): a tag named after an `Object.prototype` member (`<toString/>`, `<constructor/>`, `<__proto__/>`, …) no longer crashes the compile.** Marko 6.3.51 throws a raw `TypeError: undefined is not an object (evaluating 'filePath.length')` for it, because its taglib lookup indexes a plain object. `compileSource` and `parseFragment` now strip the prototype from the lookup's tag map, so the name is an ordinary tag name on every target (recorded in `divergences.md`); `lower.ts` guards two more plain-object lookups (`declarations.tags`, the non-DOM event spellings) with own-property checks. A declared `customTags` entry of that name is a contract.

### Fixed: a comment before an attribute tag is a child comment (body-beside)

Marko's parser moves a comment written right before an `@tag` into the parent's `attributeTags`. `lowerAttributeTags` lowered it as an attribute tag with an empty name and a NaN `nameSpan`, which every target then emitted: the HTML target passed a `"": () => ...` prop, the Preact/React/Hono/Solid targets emitted `<Card ={undefined} ...>` (invalid JSX), and the Angular and Astro targets threw `<@/> has no body`. The comment now lowers as an ordinary child `Comment` in the parent's content, in source order, so no empty-name attribute tag exists and each target treats it as it treats any other child comment. This holds after an attribute-tag `<if>` chain too (a comment skipped by the chain scan is no longer lost). Emitted output changes only for a template with a comment directly before an attribute tag, from broken to correct (Marko strips such a comment; `oracle:marko` fixture `comment-before-attribute-tag`).

### Fixed: an empty `{}` declaration is a contract (empty-declaration)

`customTags: { pub: {} }` was treated as contract-less ("custom tag has neither a `transform` nor a template file ...") while `pub: { attributes: {} }` passed. `isContractOnlyDelegated` no longer looks for a declaration key: a definition with no `transform` and no template is contract-only whatever it declares, `{}` and a hooks-only definition included (an empty declaration is a tag with no attributes and no body rules). It still needs a target that delegates the name; on a target that does not, the "neither a `transform` nor a template" error is unchanged. Covers `customTags`, `mx.contracts` entries and sidecars through the one predicate.

### Fixed: every printed position is 1-based (zero-based-cols-in-message-text)

Ruling #227: a position MX **prints** — in a message's text as much as in a `file(line,column)` header — is 1-based line and column, the basis `mx-tsc` and every editor use. This completes the pass that started with the duplicate-attribute warning and the Angular build prefixes; the structured `line`/`column` on `MxWarning`, `ScanDiagnostic`, `TargetPolicyDiagnostic` and `TranslateError` are unchanged and stay 0-based (Babel's base), because every consumer subtracts one on the way to an LSP range.

- `warn()`'s `console.warn` fallback printed `file:line:column` with the raw 0-based column (`test.mx:5:20`), one left of the position a build reports and an editor underlines. Now `test.mx:5:21`; the recorded `MxWarning` is untouched, so the language server, `mx-tsc` and every host's `warnings` list see the same value as before.
- `spanPosition` (the `file:line:column` a callee's unreadable `Input` names) now returns a 1-based column, so the unreadable-`Input` message `... (card.mx:2:24): Unexpected token` points at the 24th character rather than the 23rd.
- The `parseFragment` padding-contract errors (`assertBaseContract`, `positionRegionSource`) print their position 1-based too, clamped at column 1 rather than printing a negative one; `TranslateError.line`/`column` still carry the raw numbers.
- `readParseOptions` drops Babel's trailing 0-based ` (L:C)` from the message it embeds (`could not be parsed: Unexpected token`), reusing `dropOwnParserPosition` — the same helper the TypeScript plugin and the language server already share, so a sidecar parse failure names one position instead of two.

Tests: `src/warning-position.test.ts`, the padding-contract rows in `src/fragment.test.ts`, and the two `Input`-unreadable rows whose expected columns are corrected to the 1-based value they were always meant to be.

### Added: `nearestName` export (unknown-tags)

`nearestName(name, candidates)` — the unambiguous-nearest-name helper behind core's did-you-mean hints — is now exported so a target can hint at a declared name (the data target's `unknownTags: "reject"`). Additive; no behaviour change.

### Fixed: a failed target load is retried on every resolution (registration PR 7 round 3)

Round 2's failure cache is removed: it was keyed on the entry file, so a fix to a module the entry requires was never picked up. A throwing or invalid target is re-evaluated per resolution, as in round 1, and reloads after a fix to any file. The registration-verdict cache stays. After installing a missing target, restart the language server, TS server or dev server: both Bun and Node keep a resolution miss once the project has a `node_modules` (TODO `target-loader-sticky-not-found`).

### Fixed/Changed: third-party targets, round 2 (registration PR 7)

Rule 3 compares host names for loaded descriptors: a bare `mx.host` naming the loaded target's host selects it with no `unknown-host` warning, and two loaded specifiers of one host agree. A loaded descriptor is rejected with `target-invalid-descriptor` when it declares `host.fileKinds` (`file kinds are supported for built-in targets only (for now)`, TODO `third-party-file-kinds`) or names a built-in host (`host "solid" belongs to the built-in targets; a third-party target cannot join it (for now)`, TODO `third-party-join-builtin-host`). The registration verdict is cached per descriptor and lookup shape, and a load failure (throws, invalid) is cached under the target package's manifest and entry-file stamp, so a throwing module is not re-evaluated per file; a fixed package reloads.

### Added: load a third-party target from `package.json#mx.target` / `mx.host` (registration PR 7, decisions 129/132)

A package specifier under `mx.target` or `mx.host` (containing `/` or starting with `@`, `.` or `/`) is now loaded through `loadTargetDescriptor(spec, fromDir)`, resolved from the project's `package.json`, replacing the "loading a target package is not supported yet" staging error. `TargetPolicy` gains the optional `descriptor` (the loaded descriptor, absent for built-ins; read it as `policy.descriptor ?? lookup.target(policy.target)`), and `TargetPolicyDiagnosticCode` gains `target-not-found`, `target-load-failed`, `target-invalid-descriptor` and `host-invalid-descriptor`. A specifier that resolves and then fails is an error with no fallback to a guessed target (OQ2 c); a bare unknown word under `mx.host` keeps its warning (OQ10 unchanged: the tool calls `descriptor.load(core)` with its own core). A descriptor is also checked against the caller's lookup, so it cannot reuse a built-in's name, package, host or file-kind segment, nor a name the registry reserved. `TargetLookup` gains the optional `reservedNames()` (what `createTargetLookup` was given), which the loader passes on. Messages are one line then the action, positioned at the key's value with `length`. Core names no host and no target; spec §13.5 and the "Third-party targets" docs page.

### Fixed: mutable scriptlet replacement advice (scriptlet-hint-let-var)

Both the parse-error and lowering paths preserve the declared `const`/`let`/`var` keyword through `HostDeclarations.scriptletReplacement(name, keyword)`. The default suggests `<const>` only for `const`, and `<let>` for `let`/`var`; hosts that reject `<let>` override the advice or omit it by returning an empty string. Host choices remain outside core (decision 126); scriptlets are still rejected (decision 54). Lead ruling 2026-10-03 (question 37): the default says what Marko says (`<let>` is the mutable binding), so a host that cannot do `<let>` must override the hook (documented on `scriptletReplacement`); the `keyword` parameter is additive and no published host is affected.

### Fixed: preserve normalized whitespace-only bodies (jsx-whitespace-body-parity, decision 141)

`hasContent` now tests Marko-normalized text for nonemptiness rather than trimming it again. Same-line spaces/tabs supply one-space content through imported components, discovered template tags and attribute-tag bodies; newline indentation already removed by Marko stays absent. Host-independent, with no second normalization pass. `openTagOnly` consequently rejects retained same-line spaces on transform tags too; dropped newline indentation stays accepted. Rendered regressions cover all seven hosts; the data target retains the same text and still rejects it under `structural: "reject"`.

### Added: package-level contract modules (`mx.contracts`, decision 142)

`package.json#mx.contracts` accepts a module string, `{ module, hosts? }`, or an array. Modules default-export the new `ContractMap` type: declarations plus optional `analyze`, never transforms, finalizers or templates. Both discovery walks load them synchronously after local `tags/` and `mx.tags`, with whole-entry replacement and positioned shadow/duplicate warnings. Configuration and resolution errors point at the manifest's `"contracts"` key; module load and declaration errors point at the module file. Module paths and parser options participate in signatures, preserving content-aware hash invalidation and stable unchanged maps. Transitive imports are not tracked; keep modules self-contained. Spec §9.2/§9.7, `divergences.md`, and core regression tests; no host-specific code.

Round 2: host restrictions are applied before resolving entry precedence and module duplicate/shadow warnings, so restricted entries cannot hide unrestricted fallback contracts for other hosts or hostless callers. Module validation and stamps still cover ineligible entries. Broken-manifest warnings name both settings and explicitly say that none load without a previous valid revision; otherwise the last good settings stay in force. Absent `mx.contracts` avoids key-position tokenization. The spec documents `require`/`default` export conditions and limits Node's restart requirement to ESM/TS modules; `.cjs` reloads correctly.

### Added: `dropOwnParserPosition(error, message)` (ts-plugin-ts80001-babel-suffix)

Drops Babel's trailing 0-based ` (line:column)` from a parse error's message only when it provably repeats the error's own parser `loc`; a `TranslateError`, a plain `Error` or a suffix that differs from `loc` keeps its text. Generic; used by `@mxlang/typescript-plugin` and `@mxlang/language-server` so every surface prints the same `TS80001` text.

### Fixed: scan and target-descriptor caches detect same-tick edits (scan-cache-content-aware)

`scanCached` now compares the text of every already-tracked template and sidecar on an mtime hit. The loaded tag-map signature also includes a text hash, so unchanged parser options cannot reuse a sidecar's memoized old hooks. An unchanged scan adds one read per tracked tag file; manifest text reads and directory-entry comparisons were already content-aware (directory mtimes are not used). `loadTargetDescriptor` confirms the nearest manifest's mtime against its path and text, costing one manifest read per lookup, and reloads package-owned modules after a same-tick or pinned-mtime manifest edit. Source-only edits without a manifest change remain outside the installed-target reload contract. Pinned-mtime, same-size regressions cover templates, sidecar options, hook-only changes, target package internals, and directory add/remove. This supersedes the earlier mtime-only cache-family descriptions below; `template-tag.ts` and `callee-input.ts` already compare source and are unchanged.

Round 2: scan snapshots now retain SHA-256 hashes instead of template, sidecar or manifest text per directory key; the loaded signature reuses the snapshot's hashes. Each unchanged scan reads and hashes each already-tracked tag file and manifest once, with fixed-size 64-character hashes rather than file-sized retained text. Target-loader manifest stamps likewise retain hashes only; an unreadable nearest manifest (including a directory named `package.json`) stays cached while its path, mtime and readability are unchanged, and a readability or mtime change still reloads it.

### Added: attributes and children on declared attribute tags (contract-e4, decision 138)

`CustomTagAttributeTag` gains recursive `attributes`, `attributeTags` and `children` maps (including the lead's 16:50 children ruling). The shared attribute validator checks the full vocabulary, E1's `array` / `function` / `items` included, at every depth; defaults on attribute-tag attributes are not applied. The E2 checker validates authored plain children before lowering, with `#text`, required/repeatable paths through `<if>` / `<for>` and complete owner-chain diagnostics such as `` `<card>`: `<@row>`: unknown attribute `bogus` ``. Nested attribute-tag cardinality uses the preserved control-flow tree. No-map declarations keep the prior no-template shape and control-flow rejections. Unknown declaration keys and E1 contradictions are checked recursively at registration; plain child declarations remain cardinality-only. Spec §9.7/§9.8, sidecar/reference docs, `divergences.md`, and core/data tests; no host-specific core code (decision 126).

### Added: explicit target selection (target-select, decisions 129/132)

`mx.target` selects a registered target, including its host behaviour. When
`mx.host` also resolves, they must agree: `target-host-mismatch` is an error,
positioned at the target value with related information at the host. Unknown
targets and package specifiers are positioned `unknown-target` errors; package
loading is not supported yet. Diagnostic ranges carry the JSON value length.
Core remains open-set. Target names in `mx.tags[].hosts` warn with a host hint.
Existing configurations without `mx.target` resolve unchanged.

### Fixed: a same-tick, same-size `package.json` rewrite is no longer served stale (core-package-json-ctime-cache)

`readPackageJsonCached` keyed its cache on `mtimeMs:ctimeMs:size:ino` alone. Linux before 6.13 stamps ctime at jiffy granularity (4 ms at HZ=250), so an edit that kept the size inside one tick, with the mtime pinned, left the key identical and the old `mx.host` / `mx.tags` kept winning. On a stamp hit the cache now also reads the file and compares its text with the cached text (one read plus a string compare per lookup of an unchanged file; a stamp miss costs what it did). `setPackageJsonStatForTests` lets tests freeze the stat to reproduce coarse timestamps on any OS. The other stat-keyed caches in core (`scan-cache`, `template-tag`, `callee-input`, `target-loader`) key on `mtimeMs` only by design and never depended on ctime.

### Fixed: the scan cache confirms a `package.json` hit against its text (core-package-json-ctime-cache)

`scanCached` compared each scanned `package.json`'s mtime only before returning a cached scan, ahead of the content-aware reader, so a same-tick rewrite (or a pinned mtime) kept serving the old `mx.tags` and diagnostics. The cached entry now also holds each manifest's text and a hit requires the file text to match. `setPackageJsonStatForTests` is typed with a local structural `PackageJsonStat` so no `node:fs` type reaches the emitted `.d.ts` (`pack-hygiene` forbids node builtins there). Tag-file and directory-listing freshness in `scan-cache`, and `target-loader`, stay mtime-keyed (TODO `scan-cache-content-aware`).

### Added: allowed authored parents for custom tags (contract-e3, decision 138)

`CustomTag.parents?: string[]` restricts authored direct parents; the reserved `"#root"` key permits a file or template unit's own top level, including recursive calls. `<if>` / `<else-if>` / `<else>` and `<for>` are transparent; all other authored tags break the chain, with `"@row"` naming the parent inside an attribute-tag body. Omitted parents keep placement open; an empty list allows none. A generic lowering-context ancestor stack checks placement before lowering a custom call's body, for transform tags, templates with declaration-only sidecars and parents-only delegated contracts. Discovery carries the declaration. Registration rejects a parent listing a child whose declared parents exclude it, and the converse: a child naming a parent whose closed children exclude it. Both messages name the two tags and end with the two alternative list edits. `<define>` is not transparent, and a dynamic parent never matches a declared parent (even its diagnostic placeholder). Violations report the first positioned error at the authored tag, naming expected and actual parents (or top level). Spec §9.7/§9.8, sidecar docs, `divergences.md`, and core/data regression tests; no host-specific core branch (decision 126).

### Added: allowed authored children for custom tags (contract-e2, decision 138)

`CustomTag.children` is a closed record of `{ required?, repeatable? }` declarations; the reserved key `"#text"` allows non-whitespace text and interpolations. Whitespace, comments, `<const>` and `<define>` declarations do not count. Core validates authored child names before lowering, including transform children, template tags with declaration-only sidecars and contract-only delegated tags. `<if>` / `<else-if>` / `<else>` and `<for>` are transparent: requirements hold on every path and loops need repeatability. Dynamic children are rejected in a closed contract. Unknown children, text, dynamic children, repetitions and missing children report the first positioned error; repeat errors point at the second occurrence (or the sole loop occurrence). Registration rejects children with `parseOptions.text: true` or `openTagOnly: true` and unknown child-declaration keys. Optional `TagCall.childTree` and exported `ChildNode` / `CustomTagChild` expose authored structure to hooks without changing emitted IR. Spec §9.7/§9.8, sidecar docs and `divergences.md`; core and data-target regression tests.

### Added: `array` and `function` attribute types for tag contracts (contract-e1, decision 138)

`CustomTagAttribute.type` accepts `"array"` and `"function"`, plus an optional `items: "string" | "number" | "boolean"` for arrays. The call-site check reads the attribute's Babel node: a literal array is an array (each literal element is checked when `items` is set, a non-literal element passes), an arrow function, a function expression or the method shorthand `value({ post }) { … }` is a function, a string, boolean, number or object literal is the wrong type for either, and an identifier, call, member or conditional is accepted because its type is unknowable (the rule `string` and `number` already follow). Messages: `` attribute `values` must be array, got string `` at the attribute, and `` attribute `values` item 2 must be string, got number `` at the element. Registration rejects `items` without `type: "array"`, an `items` value outside the three literal types, and `enum` with `array` or `function`; `items` joins the allowed-key list. Existing contracts are unchanged. A template literal counts as a string and a bound attribute (`value:=…`) is checked like a dynamic one. A function expression or method shorthand reaches the contract only on a host that resolves attribute methods (`resolveAttributeMethod`). An mx-only check beyond Marko (`divergences.md`); spec §9.7 and §9.8.

### Added: `HostOptions.stripTypes`, a pass-through to Marko's compiler (jsx-handler-typing, decision 140)

Optional and unset by default, so a normal compile is unchanged. Marko's `output: "html"` strips TypeScript annotations from any expression it has to reprint, which dropped the parameter types of attribute-method shorthand handlers (`onClick(a: string) {…}`). A host's tooling mode sets `stripTypes: false` to keep them for type checking. Nothing host-specific lives in core.

### Fixed: a CDATA section or an XML declaration is a positioned error on every target (core-cdata-error, decision 139)

`<![CDATA[…]]>` and `<?…?>` were dropped in lowering on every host — Marko's parser makes a `MarkoCDATA` and a `MarkoDeclaration`, and core's IR has no node for either, so both fell off the end of `lowerChildren`' switch. `<a><![CDATA[ x ]]></a>` compiled to `"<a></a>"` and `<?xml version="1.0"?>` to `"<a></a>"`: wrong output, green build. Lowering now raises a positioned `TranslateError` on both, at the `<` of the construct, with Marko 6.3.51's meaning and MX's wording: `` `<![CDATA[…]]>` is not supported: write the text inline, as `${"…"}` when it must stay raw, or in an attribute value `` and `` `<?…?>` (an XML declaration or processing instruction) is not supported: remove it ``. Marko rejects both (`runtime-tags/src/translator/visitors/cdata.ts`, `visitors/declaration.ts`). A **raw-text** body (`<script>`, `<style>`, `<textarea>`, `<title>`) is read by Marko's parser as one `MarkoText`, so the construct there is ordinary text and reaches the output verbatim — probed and pinned, not assumed. Output changes only for templates that contain either construct outside a raw-text body, where the change is from silently wrong to an error. Spec "CDATA sections and XML declarations"; `divergences.md` unchanged, because this matches Marko.

### Added: did-you-mean and where-to-import hints on an unresolved tag (fix-hints-batch, audit item 14)

One short, positioned hint appended to Marko's wording; the error, its position and its count are unchanged.

- **Unresolved tag** (`unresolvedCustomTagMessage(name, { candidates?, hint? })`, additive options, `UnresolvedTagOptions` exported): a lowercase name gets Marko's own ``Did you mean `<div>`?`` wording when exactly one HTML element is nearest (`did-you-mean.ts`: swapped letters count as one edit, two edits only from five characters, ties and names under three characters say nothing; Marko's own pick for `<dvi>` is `<bdi>`); a capitalized name gets the nearest in-scope import or `<define>` the same way, otherwise the host's `hint` saying where the tag can come from.

### Added: host-supplied scriptlet replacement; hint fixes (fix-hints-batch round 2)

`HostDeclarations.scriptletReplacement?(name)` (optional, additive) supplies the replacement for a `$` scriptlet that declares a value; the default stays ``declare a value with `<const/name=…/>` ``. `@mxlang/solid` says to declare it in the surrounding TypeScript module and `@mxlang/astro` in the `---` fence, because their templates reject `<const>`. The sentence is now only added when the statement declares exactly one variable (`const|let|var NAME =`, no second declarator); a call, assignment, class, import or destructuring gets the bare "scriptlets are not supported". The scriptlet hint no longer fires inside a multi-line `{…}` attribute value or `${…}`. A multi-error aggregate puts each fix hint on its own frame (found by the entry's `:line:column`, first un-hinted occurrence). The did-you-mean list drops `search` and `slot`, which `@mxlang/html` cannot resolve.

### Added: fix hints on attribute-value, scriptlet and event-binding errors (fix-hints-batch, audit item 14)

One short, positioned hint per error, appended to the reason; the error, its position and its count are unchanged. Semantics are Marko 6.3.51's, and every suggested form is compiled in a test.

- **Parse errors** (`parse-error-hints.ts`, applied beside the close-tag-opener annotation in `compileSource`, on `message` and `label`): `<div id= class="a">` (`Unexpected token, expected "{"`) now ends ``; `id=` has no value; write `id="…"` or `id=expr`, or drop the `=` ``; a syntax error inside a `$` line ends ``; scriptlets (`$ …`) are not supported; declare a value with `<const/x=…/>` `` (Marko 6.3.51 rejects every scriptlet in the tags API), naming the declared variable when the line is `const|let|var NAME =`. The position stays where Marko puts it (the second `=` for the first case, though the missing value is at `id=`).
- **A valid `$` scriptlet** (lowering error, decision 54) carries the same ``declare a value with `<const/x=…/>` `` fix.
- **`(click)="go()"` on an element** now ends ``; for an event handler write `onClick=go` `` on a host that renders handlers (it declares `resolveAttributeMethod`); `go()`/`go` give `go`, anything else `handler`, and only a lone identifier argument qualifies. A host that renders once to a string (`@mxlang/html`) has no handler form to suggest, so its message is unchanged.

### Fixed: a `TranslateError` message no longer starts with the compiled file's path (translate-error-no-repeated-path, audit item 17; no-repeat-path-relative-spellings)

`compileSource` drops the `<filename>: ` prefix Babel adds to a translator error's message. The error already carries `line`/`column` (and `file` for an error in another file), and every surface prints the file itself, so the prefix only repeated it, as an absolute path, in `mx-tsc`'s `TS80001` and the language server's message. The comparison is two-sided: the leading path is extracted from the message and both sides are compared by `resolve`/`realpathSync` identities (a file missing on disk resolves only), so the strip holds however Babel and the caller each spell the file — absolute, relative, symlinked, or two independent aliases of one directory; a prefix naming a different file is kept, never stripped.

### Changed: core resolves targets from a caller-supplied lookup, and names none (refactor/target-open-set, decisions 129 and 132)

**Behaviour-preserving refactor, except for the dotted-name rule below and the ruled own-only warning policy.** Core held a closed list of the seven built-in hosts (`HOST_NAMES`, `HOST_PACKAGES`, `isKnownHost`, `DEFAULT_POLICY`, `HOST_MODULE_SEGMENTS`, `MX_ATTR_TAG_SOURCES`); all are gone, replaced by a required `TargetLookup` (decision 126). Every entry point that needed one now takes it, so forgetting it is a type error rather than a silent loss of validation:

- `resolveTargetPolicy(filePath, lookup)` and `resolveTargetPolicyDetailed(filePath, lookup)` — the lookup is a required second argument. `TargetPolicy` gains `target: string` and `host?: string`; the default policy is `lookup.defaultTarget()`.
- `hostModuleSegment(entry, lookup)` — a required lookup instead of the `HOST_MODULE_SEGMENTS` array, which is no longer exported.
- `ScanOptions` gains a required `targets`; `discoverProjectTagsOptions` likewise. The scan cache stays lookup-free (directory, `stopAt`, `host`); dotted-filename evidence is cached neutrally and diagnostic wording is derived per caller. `host: null` excludes every restricted entry for a target with no filter key, unlike intentionally unfiltered `host: undefined`.
- `ScanResult` gains `hostRestrictions`, every `mx.tags[].hosts` value the scan read, and the scan no longer decides which of them are known. New export `hostRestrictionDiagnostics(restrictions, lookup)` produces the diagnostic for a bare unknown word — today's text, byte-identical — when called by full-registry tooling. Own-only loaders do not call this helper and leave peer restrictions unresolved without a warning (PR 3 round-2 ruling). Package specifiers remain silent. Filtering and malformed-shape checks are unchanged.
- `ResolveContext` gains a required `targets`, `Ctx` too, and `newCtx` takes it as a sixth argument. The `AttrTag` source set is now `@mxlang/core` plus `lookup.attrTagSources()` (every registered target's `packageName`), and the file-kind test in the callee reader asks `lookup.moduleSegments()`. The module-level reader registry (`registerCalleeInputReader`) is unchanged and still generic. Callee analysis is cached per lookup identity as well as the existing path/resolver and dependency snapshots.

The messages do not change: the unknown-`mx.host` list is every non-deprecated `mx.host` value in registration order with the deprecated one named apart (for the built-ins, the same string as before), the malformed-`package.json` clause reads the lookup's default target, and the deprecated-alias warning names the value and the target it selects. `TargetPolicyDiagnosticCode` keeps `unknown-host` and `malformed-package-json` (decision 07 Q9).

### Added: `isTranslateError`, a brand check that survives two copies of core (refactor/target-open-set)

A host resolved from a project brings its own `@mxlang/core`, so an error it throws is not the class a tool checks with `instanceof`; every positioned error from it degraded to a wrapped, positionless one. `TranslateError` now carries a `Symbol.for("mxTranslateError")` brand and core's own `instanceof TranslateError` checks read the new `isTranslateError(error)` export (design note §4.4, mitigation 2). No behaviour change within one copy.

### Changed: a dotted tag file name is rejected, not indexed (refactor/target-open-set, decision 137)

**Behaviour change.** A `<base>.<word>.mx` file under a `tags/` or `mx.tags` directory is no longer indexed as a tag. It could never be called: the tag form `<base.word/>` and the concise form `base.word` both parse as tag `base` with shorthand class `word` (measured on Marko 6.3.51 and on this parser), so the entry was a dead tag with no word to the author.

Such a file is now excluded from the tag map with a positioned diagnostic, in one of two forms. When `<word>` is a file-kind segment a registered target declares (`ng`, `solid`, `astro` for the built-ins) the wording is unchanged — `` `${entry}` is a host module file, not a tag template; tag templates are `.mx` ``. Otherwise: `` `${entry}` cannot be called as a tag: `<${bare}>` parses as tag `${tag}` with class `${classes}`. If it is another host's module file it does not belong under this host; otherwise rename it without the dot. `` Which form applies depends on the caller's lookup: a direct entry that knows only its own targets (a Bun loader, the Angular CLI) sees another host's file kind as the second case and still rejects the file. An mx-only lint beyond Marko, which indexes such a file silently; recorded in `divergences.md`, and spec §9.2 states the rule.

### Added: spans on Text, Comment and structural IR nodes (core-ir-spans)

**Additive only; nothing that exists today changes.** `Text`, `Interpolation`, `Comment`, `IfChain` (and each `Branch`), `For`, `Const`, `Define`, `Import`, `Export` and `Static` gain an optional `span?: SourceSpan` (file-absolute UTF-16 code-unit offsets, the `Expr.span` convention). `Text.span` slices the text exactly as authored, which `value` has Marko-normalized. `Interpolation.span` covers the whole `${…}` / `$!{…}`, delimiters included (`expr.span` still covers the expression only). `Comment.span` includes the delimiters (`<!-- … -->` or the `//` line). `IfChain.span` runs from the `<if>`'s `<` through the last branch's closing tag; each `Branch.span` covers that branch's own tag, body and closing tag included, as do `For.span`, `Const.span` and `Define.span`. `Import`/`Export`/`Static.span` cover the authored statement with the trailing line terminator trimmed, because Marko's statement `loc` ends on the next line's column 0; a trailing same-line comment is part of the span, as it is of the statement's `code`. Synthesized nodes — an inert disposition's or `<return>`'s empty `Text`, builder-produced nodes, a `synthesized: true` `Import` — carry no span. This is the data target's core spans PR (decisions 131/132, 06 answer item 7): consumers such as the data tree and formatters can now slice authored source for every IR kind. Tests in `src/spans.test.ts` slice the source with each span, including under emoji (UTF-16) and CRLF line endings.

### Fixed: opener position on statement tags with TypeScript generics and on aggregate errors (missing-close-tag-opener-position, round 2)

The replay now declares Marko 6.3.51's core taglib parse options (statement: `class client export import server static`; openTagOnly: `const debug id let lifecycle log return`; text: `html-comment html-script html-style script style textarea`), so `export interface Input<T = string>` or `static const xs: Array<string>` above the mismatch no longer defeats it. An aggregate error (several parse errors, no `loc`) has each entry annotated and the same suffix written into the aggregate message. The message is written with `defineProperty` because `CompileError.message`'s setter discards the first assignment.

### Added: a mismatched closing tag names the opener's position (missing-close-tag-opener-position, audit item 12)

`compileSource` appends ` at line:column` (1-based, UTF-16 columns, the `<` of the innermost unclosed tag) to Marko's `The closing "div" tag does not match the corresponding opening "p" tag` error, on `message` and on `label`. The error stays at the closer. Marko 6.3.51's error carries no second location, so core replays the source through `htmljs-parser` (new exact-pinned dependency, 5.15.0, the copy `@marko/compiler` already uses) and only annotates when the replay reproduces the same error at the same position; otherwise the message is untouched. Reaches every Marko-path host (html, preact, react, hono, astro, angular whole-file).

### Feature: a repeated attribute name resolves last-wins in core (dup-attr-last-wins-core, decision 135)

Within one tag the last occurrence of an attribute name now wins on every host: `lowerAttrs` drops the earlier ones, so the IR carries one attribute per resolved name (the last, with its own spans, at its own position) and no emitter or delegated-tag consumer sees a duplicate. This is Marko 6.3.51's behavior (`<div class="a" id="x" class="b">` is `<div id=x class=b>`, the dropped value is never evaluated, `class`/`style` do not merge). The decision-133 warning stays, now positioned on each DROPPED occurrence and naming the survivor: ``duplicate attribute `class`: the later one at 1:16 wins, so this one is dropped`` (1-based in the text, core's 0-based column in the structured position); three occurrences give two warnings. Never an error, `mx.strict` included. Output changes only for templates that already got the warning. A default attribute is named `value`; a spread never counts; `onClick` beside `on-click`, `class` beside `Class` and Angular `x`/`[x]`/`(x)`/`#x` stay distinct. Spec "Duplicate attributes"; `divergences.md`.

### Added: the target descriptor contract and a synchronous loader (target-descriptor, decisions 129 and 132)

**Unstable; nothing consumes it yet.** New exports: `TargetDescriptor`, `TargetHost`, `TargetCompiler`, `TargetCompileOptions`, `TargetCompileResult`, `HostFileKind`, `HostRegionInput`, `HostRegionResult`, `TargetLookup`, `validateDescriptor`, `createTargetLookup`, `TargetDescriptorError`, `TargetLookupError`, `loadTargetDescriptor`, `clearTargetDescriptorCache`, `TargetLoadError`, `TargetLoadErrorCode`, `TargetLookupRule`. A descriptor is plain data plus a lazy `load(core)`; `createTargetLookup` enforces distinct target and host names, caller-supplied `reservedNames`, `packageName` uniqueness (shared only within one host), one `host.default` per multi-target host, and a single non-deprecated `legacyHostValues` entry as a hostless target's filter key. `loadTargetDescriptor` resolves from the project like `loadSidecar` does and caches by resolved path and the nearest `package.json` mtime. When that manifest belongs to the target package, a change re-evaluates the entry and the modules under the package directory (not a nested `node_modules`); when it is the project's own, only the entry file. No existing behaviour changes.

### Feature: a duplicate attribute is a positioned warning on every host (dup-attr-warning)

`<div class="a" class="b">` (or `on-click` twice) now raises one `MxWarning` per repeated attribute, positioned at the repeat's name and naming the earlier occurrence as a 1-based `line:column` (decision 133). Never an error; emitted output is byte-identical to before. Marko 6.3.51 accepts duplicates silently. Names compare case-sensitively on the resolved attribute name; a spread and `onClick` beside `on-click` do not count. The warning reaches `mx-tsc` and the host compile APIs' `warnings` lists through the existing channel, and a Vite build through core's `console.warn` fallback (build still succeeds). An mx-only lint recorded in `divergences.md`; spec §4 "Duplicate attributes".

### Changed: `astro` joins `HOST_MODULE_SEGMENTS` (amx-to-astro-mx, decision 134)

The Astro template kind is renamed from `.amx` to `.astro.mx`, so `hostModuleSegment("card.astro.mx")` is now `"astro"` and a file of that kind under `tags/` is reported as a host module file instead of being silently skipped (it was `.amx`, without the `.mx` suffix). No other core change.

### Breaking: `claimsTag`/`HostTag` renamed to `isDelegatedTag`/`DelegatedTag` (delegated-tag-rename, decision 132)

**Breaking, no aliases.** `HostDeclarations.claimsTag` is now `isDelegatedTag`, `HostDeclarations.resolveHostTag` is now `resolveDelegatedTag`, the IR kind `HostTag` (the `kind` literal and the type) is now `DelegatedTag`, and the `ctx.build.hostTag` builder is now `ctx.build.delegatedTag`. `Emitter.hostTag` is now `Emitter.delegatedTag`; the exported helper `isContractOnlyClaimed` is now `isContractOnlyDelegated`. Hosts must rename these; behaviour, output and diagnostics are unchanged. Earlier entries below keep the names they shipped with. Spec §9.8.

### Fix: reading `input` whole no longer warns that an `<@attribute>` tag was dropped (attr-tag-dropped-false-warning)

**Behaviour change (removed false warnings only):** a template unit that read `input` whole (for example `tags/resource.mx` containing only `<return=input/>`) made every caller warn "`<@attribute>` was dropped; … does not read `input.attribute`" (and "body content was dropped"), although the emitted call passes the value. The metadata counted only `input.<name>` member reads. A bare, unshadowed `input` that is not the object of a member read now counts as reading every attribute tag and the content: returned (`<return=input/>`), assigned (`const copy = input`, `static const p = input`), passed to a call (`fn(input)`), spread (`...input` into an object, an attribute list or a tag call), and destructured with a rest element. A rest-less destructure (`const { a } = input`) still reads only the named properties, so a dropped `<@b>` still warns, as does a member read of another name or a shadowed local named `input`. A destructure with a computed non-literal key now counts as a whole read, and an object literal in expression position (`{ ...input }`) is now scanned (it was a parse failure that hid the spread). Marko 6.3.51 has no such lint (it silently omits the unread attribute tag); the warning remains an MX-only lint, now correct. Fragments are now parsed with the TypeScript plugin and top-level `await` allowed (`input as any`, `input!.x`, `satisfies`, typed arrow parameters, `await input`), a default value inside a destructure (`const { v = input.y } = input`) is scanned, and a fragment that still cannot be parsed but names `input` counts as a whole read, so a parse failure suppresses the warning instead of causing a false one. Not counted as member reads (conservative, a missed warning): an alias (`const i = input; i.x`), `typeof input` and `"y" in input` are whole reads. No emitted code changes.

### Chore: the spelling hints name no framework (core-hints-neutral-names)

**No behaviour change.** The hint shown for a `#…` attribute name now reads "`#…` template reference variables have no meaning in MX" and the one for `*…` reads "`*…` structural directives have no meaning in MX; use `<if=cond>` / `<for|item| of=list>`" (previously "… are Angular syntax"). When the hints fire, where they are positioned and the `onDoubleClick` warning text are unchanged. Internally `REACT_EVENT_SPELLINGS` and `warnOnReactEventSpelling` are now `NON_DOM_EVENT_SPELLINGS` and `warnOnNonDomEventSpelling`.

### Fix: a default attribute's `nameSpan` is zero-width at the `=`, as in Marko; tags and static values gain spans (core-span-fixes)

**Behaviour change (one diagnostic position):** `<x="post">` lowers to `name: "value"` with a `loc` that starts at the `=`, so `attrNameSpan` measured `"value".length` from there and `nameSpan` covered `="pos` (for `resource="post"`: 8–13). A default attribute has no spelled name, and Marko anchors it with an empty range at the attribute start (htmljs-parser 5.18.0 `ensureAttrName`; `@marko/language-tools` 2.7.0 treats the empty range as "default"), so `nameSpan` is now zero-width at the `=` (8–8). Consumers detect the empty range, as Marko does. Method shorthand (`change(ctx) {…}`) was already correct and is pinned by a test. Spelled attributes and `name:modifier` spellings are unchanged.

**Additive IR fields**, all optional, all UTF-16 code-unit offsets into the source string like every existing span: `span` (the whole tag: opening tag, body and closing tag) and `nameSpan` on `HostTag` and `Element`; `span` on `Component` (which already had `nameSpan`) and on `AttributeTag`; `valueSpan` on a `static` attribute (the string literal, quotes included, like `Expr.span`). `HostTag.nameSpan` is `undefined` for a dynamic tag. No emitted code changes.

### Fix: a `.ng.mx` callee reads as untyped, not as an invalid Marko parse; callee-input no longer names `.solid.mx` (core-host-cleanup)

**Behaviour change:** a host module file (`card.ng.mx`, `card.solid.mx`) with no registered callee-input reader used to fall into the plain `.mx` branch of `readCalleeInput` and be Marko-parsed. For `.ng.mx`, which no host registers a reader for, that returned `{ kind: "invalid" }` ("@tags must be nested within another element", or "requires ResolveContext.ctx" without a Ctx), so a valid `.ng.mx` callee put a spurious error on its callers. It now returns `{ kind: "none" }`, the same untyped result an unregistered `.solid.mx` already had (`hostModuleSegment` is the generic test). No emitted code or oracle output changes.

The extension probes are now derived from the readers registered through `registerCalleeInputReader` instead of hard-coding `.solid.mx`. **Precondition:** an extensionless import resolves to `X.solid.mx` only once `@mxlang/solid` is loaded (its reader registration adds the probe); every tool already loads its host package. The `AttrTag` source packages are derived from `HOST_NAMES`, and two error messages say "a host module region" instead of "a `.solid.mx` region".

### Added: contract-only custom tags on a host-claimed name; `ctx.build.hostTag` carries attributes (contract-only-tags, decision 130)

A custom tag that declares only a contract (`attributes`, `attributeTags`, `parseOptions`, no `transform`, no template) is now valid on a name the active host claims (`claimsTag`). Core validates the call against the contract and lowers it to a `HostTag` with its attributes, attribute tags and children intact. On a host that does not claim the name the call still fails with "custom tag has neither a `transform` nor a template file, so a call has nothing to expand to". `ctx.build.hostTag(name, children, attributeTags, attrs?)` takes an optional fourth `attrs` argument; callers that omit it get the same node as before. No output change for any existing host. Spec §9.8. `TagCall` (public, exported from `@mxlang/core`) gains optional `span` and `nameSpan`, the UTF-16 spans of the call and of its tag name; the contract-only `HostTag` carries them like any claimed tag.

### Added: `TargetPolicyDiagnostic.code` (host-policy-diagnostics-tsc-tsserver)

Additive: every diagnostic `resolveTargetPolicyDetailed` returns now carries `code: "unknown-host" | "malformed-package-json"` (type `TargetPolicyDiagnosticCode`, exported), so a caller can word or route one without matching the message text. Messages, positions and the resolved policy are unchanged.

### Fix: `<for by=>` that reads a loop param is a positioned error, not a silent pass (audit-02-for-by-parity)

**Behaviour change:** `<for|x| of=items by=x.id>` compiled silently on html and preact and surfaced only as a stray `TS2304 'x'` at a generated position on solid. `by=` is evaluated once, before the loop, so the tag's params are not in scope there; Marko 6.3.51 rejects it (`runtime-tags` `translator/core/for.ts`, `findLoopParamRead`). `lowerForHead` now fails at the offending name, for `of`, `in`, `to` and `until`, with Marko's message and its hint (`by="id"` or `by=(x) => key`). The walk is Marko's own: a function or class in the value is skipped (`by=(x) => x.id`, `by=(y) => x.id` stay valid), a non-computed member property is a name and not a read, and an outer variable (`by=key`) or function (`by=someFn`) is accepted. Applies to every host, Angular included (its `by=(p => p.id)` and `by="id"` forms are unchanged).

### Fix: an attribute name outside Marko's grammar is a positioned error, not a silent pass-through (audit-01-prop-attr-parity)

**Behaviour change:** `<div [prop]="x">`, `<div #ref>`, `<div *ngIf="x">`, `<div [attr.x]="y">` and `<div @foo=1>` compiled silently on every non-Angular host (html passed every surface; preact then emitted invalid JSX that failed at a generated position). Marko 6.3.51 rejects them ("Invalid attribute name.", `runtime-tags` `normalizeTag`). `lowerAttr` now applies Marko's own name grammar (`[a-z_][a-z0-9._:-]*`, the same for elements and custom tags: Marko 6.3.51 also rejects `<foo $foo=1/>`) and fails at the authored name with a hint (`write \`prop=\``, `<if=cond>`, `class={ a: cond }`, …). `HostDeclarations.acceptsForeignAttrNames` opts a host out; only `@mxlang/angular` sets it.

### Fix: `resolveTargetPolicy` stops at a malformed `package.json` and at `node_modules`; unknown `mx.host` warns (host-policy-walk-edge-cases)

Three silent failures in the upward walk that decides a file's host are closed. **Behaviour change:** the first two can change which host a file compiles under, only in setups that were already misconfigured.

- **A malformed `package.json` no longer hands the file to an unrelated ancestor.** The walk used to skip a `package.json` that failed to parse (or held `null`, `[]`, a string) and keep climbing, so a project with a syntax error in its own manifest silently took a monorepo root's host. It now stops at the nearest `package.json` that *exists*, as Node, TypeScript and `scan.ts` do, and resolves to the default `html` host. The new warning names the broken file, its parse error (positioned when the runtime reports a position: V8 does, Bun does not, then it is 1:0) and the ancestor `package.json` whose host the file would have used before.
- **The walk stops at a `node_modules` directory** (Node's package-scope rule). A `.mx` file in an installed package that ships no `package.json` used to take the consumer's host; it now gets the default `html` host, silently, as Node treats it.
- **An `mx.host` that is not a host now warns** (it was ignored silently and the dependency rule decided). The warning lists the valid hosts, suggests the nearest one within two edits (`"solidd"` → `"solid"`), and is positioned at the value in `package.json`. Resolution is unchanged: the value is still ignored.
- **Unchanged, now written down and pinned by tests:** a directory with no `package.json` of its own (a monorepo member) inherits the nearest ancestor's host. Two or more host dependencies still mean `html`.

New, additive API: `resolveTargetPolicyDetailed(filePath)` returns `{ policy, diagnostics }` (`TargetPolicyDiagnostic` has `ScanDiagnostic`'s shape: `file`, `message`, `line`, `column`); `resolveTargetPolicy` is its `policy` and is otherwise unchanged. Every diagnostic is a warning; none can fail a build that worked. Only the Vite plugin and the language server surface them today — `mx-tsc` and the editor's TypeScript plugin get the new fallback behaviour (html for a malformed `package.json`, no climb out of `node_modules`) without a warning.

Internally `scan.ts` and `host-policy.ts` now read `package.json` through one cached reader keyed on mtime + ctime + size + inode (so an edit that pins the mtime or replaces the file atomically is still seen) (`src/package-json.ts`). `scanCustomTags` output is byte-identical (checked over every `.mx` in the repo plus broken/empty/`null`/`mx.tags`-typo trees).

### Fix: `parseFragment` throws on a broken base position; new `positionRegionSource` (core-parsefragment-contract-check)

`parseFragment` and `parseFragmentNative` now reject a base that cannot describe a real file (non-integer numbers, negative `baseLine`, or `baseOffset < baseLine + baseColumn` when `baseOffset` is given) with a positioned `TranslateError` naming the rule. Before, a host that clamped the impossible filler count mis-mapped line/column-only positions (attribute names) silently. The contract is now written out on `FragmentBase`.

`positionRegionSource(region, at, { wrapper?, filename? })` is new and exported: it returns the host's padded `Ctx` source together with the matching `parseFragment` base, so the two cannot diverge. `@mxlang/angular` and `@mxlang/solid` use it in place of their hand-rolled copies; their output is byte-identical. On line 0 the offset must equal the column; from line 1 it must be at least `baseLine + baseColumn`. A partial base that used to be clamped now throws, by design: `compileSolidMx` with `{ baseLine: 3 }` alone (`baseOffset` defaults to 0) is such a case. `parseFragment` cannot see a host's pad, so a host that builds its own pad is still unchecked.

### Add: `HostDeclarations.resolveDiscoveredTagModule` and `binding` on a named `Component` target (html-tags-marko-import)

Both optional. A host that answers the hook with a taglib-discovered tag's template path gets `import _name from "<relative path>"` added to the module (Marko's own form: default import, extension kept, `_` plus the camelCased name, numeric suffix on a collision, once per module) and `binding` set on the `Component` target, so its emitter can call the imported identifier while `name` stays the authored spelling. Absent, or `undefined`, changes nothing. `Ctx.lookup.getTag`'s return type also gains an optional `template?: string`, the absolute template path `@marko/compiler` already puts on the tag definition it returns (a type-only widening; nothing in MX sets it). Only `@mxlang/html` implements the hook; every other host's output is byte-identical.

### Fix: the tarball ships only `dist/` and the README (pkg-types-g10)

`tsconfig.build.json` now excludes `src/**/fixtures/**` (the scan fixtures' `*.tag.d.ts` no longer land in `dist/fixtures/`) and turns `declarationMap` off (each `.d.ts.map` pointed at a `../src/*.ts` that is not in the tarball, so go-to-definition was dead anyway). `files` drops the `types` and `LICENSE` entries, which name paths that do not exist here. `scripts/pack-hygiene.test.ts` and `scripts/pack-probe.ts` pin the tarball contents and a `skipLibCheck: false` consumer typecheck.

### Added: `TemplateMetadata.hoistedExports` (host-authoring metadata)

An optional `string[]` on `TemplateMetadata`: the verbatim source of each top-level `export` statement a template hoists (not `export interface Input`), in source order, set only when there is at least one. It lets a host read a callee's own `export const` facts from the same parsed statements its module emission uses, instead of re-scanning the callee's text — the Angular host reads a tag's exported `selector` this way. Additive, following `inputAuxCode`.

### Feature: `hostModuleSegment` and `HOST_MODULE_SEGMENTS` are exported (angular-discover-core-ext)

`@mxlang/core` now exports `hostModuleSegment(name)` and `HOST_MODULE_SEGMENTS` (previously module-private in `scan.ts`) as documented host-authoring API. `hostModuleSegment` returns the host segment of a `.mx` file name (`"ng"` for `card.ng.mx`, `"solid"` for `card.solid.mx`) or `undefined` for any other name, so a host can route its own host module files and reject or exclude another host's with core's rule instead of hard-coding suffix checks. Additive; no behaviour change.

### Internal: shared `unresolvedCustomTagMessage(name)` (source-bindings-silent-parse-failure)

Marko's own "Unable to find entry point for custom tag `<Name>`." wording (decision 114) was hand-copied at four separate `rejectUnknownTag` call sites — `@mxlang/html`, `@mxlang/solid`, the shared preact/react/hono JSX emitter, and `@mxlang/astro`. Now exported once from `core.ts` (`unresolvedCustomTagMessage`) and called from all four; no wording change.

### Fix: a non-import local value used as a tag now classifies as function-like or unknown, matching Marko for every unknown case (local extension of decision 116)

Firstmate's ruling extends decision 116 to non-import PascalCase locals (`static`/module-scope declarations, `<const>` bindings, `<for>`/`<define>` tag params): a plain `function Foo(){}`/`class Foo{}`/arrow-valued `const` stays a direct call, while anything core cannot statically prove is a function/arrow/class — a string, a conditional, a call result, or a tag param (always unknown, since its runtime value is never inspectable at lowering time) — now lowers as a dynamic tag instead of throwing `"X is not a function"` at runtime. New `Ctx.unknownLocalValue` and exported `isFunctionLikeValue` in `@mxlang/core`.

### Fix: an `Input`'s `extends` base or intersection alias hitting `MAX_ALIAS_DEPTH` no longer silently degrades (callee-input-alias-depth-silent)

`InputAnalyzer.inputMembers` (`callee-input.ts`) reads an `Input` interface's `extends` base and a type alias's intersection parts by following named-type references through `resolveNamedType`, capped at `MAX_ALIAS_DEPTH` (4) like every other alias-following path in this file. When that cap was hit for these two paths specifically, the member silently became an open index signature — `AttrTag` typing behind the truncated hop was quietly dropped, with no diagnostic at all. The sibling property-alias path (`analyzeAttrTagType`, used for `tab?: AttrTag<Alias>`) already reported "declare this attribute tag's config literally" in the same situation, through `namedTypeEventuallyContainsAttrTag` — an unbounded (cycle-guarded, not depth-capped) lookahead that tells a genuinely unresolvable name (stays open, correctly, e.g. `interface Input extends MissingBase`) apart from a real chain that does contain an `AttrTag` behind a hop deeper than the cap reaches.

Both silent paths now call the same check before falling back to an open member. `namedTypeEventuallyContainsAttrTag` itself was widened to follow `TSInterfaceDeclaration` (its body, and recursively its own `extends` bases) and `TSIntersectionType` (each part), since an `extends` base or an intersection part can be either kind — it previously only understood `TSTypeAliasDeclaration`. Both now raise the identical "declare this attribute tag's config literally" error (an `errors` map entry under `"<input>"`), surfaced through the same `raiseInvalidCalleeInput`/`raiseInvalidOwnInput` `fail(...)` path attribute-tag config errors already use — an error, not a warning, matching the existing sibling path.

New tests: a 5-hop `extends` chain and a 5-hop intersection alias, each hiding an `AttrTag` behind the fifth hop, now report the positioned error instead of silently degrading; the matching 4-hop cases (within the cap) keep resolving and typing correctly, alongside the pre-existing 4-hop property-alias test.

**Round 2 (found by review): `scanAttrs`'s nested `attrs:` config alias-following loop had the identical shape** — closing the class of bug together. `scanAttrs` follows an attribute tag's `attrs: Alias` config through the same `resolveNamedType`, also capped at `MAX_ALIAS_DEPTH`, and set `decl.nestedOpen = true` with no `namedTypeEventuallyContainsAttrTag` check when the chain could not resolve — including past the cap — so a nested `AttrTag` hidden inside a deep `attrs` alias degraded silently too. Fixed the same way: the resolution-failed branch now checks `namedTypeEventuallyContainsAttrTag` and reports the error (keyed by the attribute tag's own `propPath`, since the loop breaks before any individual nested member is reached) instead of silently opening. A genuinely missing alias (no such type at all) is unaffected and still opens with no error. New tests: a 5-hop `attrs:` alias hiding a nested `AttrTag` behind the fifth hop now errors; a matching 4-hop case keeps resolving; a genuinely-missing alias stays open with no error (new coverage — no prior test asserted `nestedOpen: true` at all).

### Fix: a value import that isn't a `.marko`/`.mx` default import now lowers as a dynamic tag (decision 116)

Measured (TODO `value-import-as-tag-parity`): Marko 6.3.51 compiles every capitalized local-import tag to `_dynamic_tag`. At runtime, a string renders as an element and a Marko template is called; anything else (a plain function, a plain object, `undefined`, `null`) renders only the body. MX previously routed every capitalized value import straight to a direct call (`lowerComponent`'s `kind: "name"` target), so a string, `undefined`, `null` or a plain object threw `"X is not a function"` on every host.

`lowerStatement`'s `import` handling now tracks, per binding, whether it is a `default` specifier whose source ends in `.marko`/`.mx` (`ctx.importDefaultFromMarkoOrMx`, populated via the new exported `isMarkoOrMxSpecifier`). The file-local-binding routing in `lowerTag` still routes a `.marko`/`.mx` default import to a direct `kind: "name"` call, exactly as before; every other capitalized value import (named, namespace, or a default from any other extension) now routes to `kind: "dynamic"` — the same lowering an authored `<${expr}/>` already produces, reusing every host's existing dynamic-tag emitter with no per-host routing change (decision 79). **Intentional divergence from literal Marko parity:** a plain function is still called and its return value kept, since an imported `.tsx` component on react/preact/hono, or an MX component on html, IS a plain function — Marko's own runtime would discard its return value, which would break ordinary host interop.

`ComponentTarget`'s `"dynamic"` variant gained an optional `valueImportBinding: string`, set only by this routing (never for an author's own `<${expr}/>`), so `readCalleeInput`/`resolveTarget` can still resolve the callee's declared `Input` for typed attribute-tag checking even though the call now lowers dynamically — without it, every value-import call would silently lose static attribute-tag typing, a regression decision 116 never authorized. `targetName` also falls back to `valueImportBinding` so a diagnostic on such a call still names the tag the author wrote, not "dynamic tag".

### Fix: a type-only import no longer resolves a capitalized tag (decision 114/115)

`importBindings(line)` (`core.ts`) previously returned every specifier of an
`import` statement with no check of `importKind`, so `import type Widget from
"./widget.mx"` (and `import { type Widget } from "..."`) bound `Widget` in
`ctx.imports` the same as an ordinary value import — `<Widget/>` then silently
lowered to a component call referencing a name erased before the module runs
(a runtime `ReferenceError`), instead of Marko's own "Unable to find entry
point for custom tag" compile error, on **every host**, in whole-file `.mx`.
A new `importTypeOnlyBindings(line)` identifies the type-only subset; `Ctx`
gained `imports` (now value-bindings only — every host's own `isComponent`
reads this directly, so this alone makes `@mxlang/html` and `@mxlang/solid`
correct with no host-side change) and `importedNames` (every binding
regardless of `importKind`, for the two readers that genuinely want that:
`needsAttrTagImport`'s "is `AttrTag` already imported" check, and
`exportNameFor`'s self-export collision check). A type-only import is still
emitted verbatim (`Import.code` is the statement's source text regardless of
`bindings`), so nothing an author wrote is dropped. Mirrors
`@mxlang/parser`'s `programBindings`, which already excluded the same two
shapes for `.solid.mx` region resolution; duplicated rather than shared,
since core may not depend on `@mxlang/parser`.

### Fix: a host's own wording for an unresolved *capitalized* tag, not just lowercase (decision 114)

`lower.ts`'s capitalized-tag guard now calls `ctx.declarations.rejectUnknownTag?.(name, node, ctx)` before its own fallback message (`` `<${name}>` has no matching import or `<define>` in scope; a capitalized tag is always a component call ``), the same way the lowercase-unresolved-element guard a few lines below it already did. A Marko-parity host (e.g. `@mxlang/solid`) can now report Marko's exact wording (`` Unable to find entry point for custom tag `<Name>`. ``, verified against `@marko/compiler` 5.42.5 / `marko@6.3.51`) for either case from one hook. A host supplying no `rejectUnknownTag` keeps the identical fallback message as before — not a behavior change for those hosts.

### Fix: a `<const>` binding and a `<for>`/`<define>` tag param now shadow a registered custom tag too (decision 113)

`custom-tags-local-bindings`: a file-local *scope* binding — `<const/Panel=…/>`,
a `<for|Panel|>` param, or a `<define/Box|Panel|>` param — now wins over a
registered custom tag of the same name, scoped exactly to where the binding is
in effect (outside that scope, the registered tag resolves again). Previously
only `import` and `<define>` names shadowed a custom tag
(`custom-tags-import-precedence`, decision 93); `<const>` and tag-param
bindings fell through to the custom tag unconditionally. Matches Marko
6.3.51's own rule (`normalizeTag`,
`@marko/runtime-tags/dist/translator/index.js`): a capitalized tag name backed
by a Babel scope binding is rewritten to a dynamic-tag reference before any
custom-tag/taglib lookup runs, for `const`, `for`-params, and `define`-params
alike. `lower.ts`'s `fileLocalBinding` check now also consults
`ctx.tagVarShadowed`, the existing scope-tracking set `shadowBindings`
maintains around every `<const>`/`<for>`/`<define>` body — so the fix reuses
the same mechanism the codebase already had for binding-aware identifier
rewriting, rather than adding a new one.

**Round 2 fix (review found a leak):** `scopeBindings` (`core.ts`) snapshotted
only `ctx.bindings`, not `ctx.tagVarShadowed`, so a `<const>` inside an
`<if>`/`<else>` branch — which never calls its own `shadowBindings` restore,
by design — permanently replaced `ctx.tagVarShadowed`, leaking the shadow
past the branch for the rest of the file. `lowerDefine` had the same bug
independently (no `scopeBindings` wrapper at all around its body). Both fixed
structurally: `scopeBindings` now snapshots/restores `ctx.tagVarShadowed`
too, closing the leak for every scope that already calls it (`<if>`/`<else>`
branches, `<for>`, `<define>` — now wrapped like the others, attribute-tag
`<if>` blocks, `<try>` via `lowerBlock`); no per-construct special case
needed.

### Fix: an unknown host name in `mx.tags[].hosts` is now a diagnostic, not silent (decision 110a)

`indexMxTagsEntries` (`scan.ts`) now checks each `hosts` entry against the
known host set (`html`, `astro`, `solid`, `preact`, `react`, `hono`,
`angular`) and records a diagnostic naming the offending host and the
`package.json`. The entry still indexes and the field still filters as
before; only the silent-typo case changes — `hosts: ["solidd"]` used to look
exactly like `hosts: ["solid"]` excluding every host, with nothing said.
`hosts` filtering itself (`applyHostFilter`, every scan call site passing its
own `host`) was already shipped; only the unknown-name diagnostic was
missing.

### Fix: a dynamic tag or `<define>` call now accepts arguments plus content (decision 109)

`rejectArgsWithProps` now takes Marko's own lenient rule for a dynamic
`<${expr}>` tag or a `<define>` call: the tag-argument form may combine with a
body or attribute tags (Marko's "dynamic tag fallback content"), and only a
plain attribute alongside arguments is still rejected. A named custom tag is
unaffected — Marko's own stricter rule (`assertAttributesOrSingleArg`)
continues to reject arguments combined with attributes, attribute tags, or a
body there. This closes the "MX 1 divergence to close" spec §15 note and TODO
`define-call-args-with-content`.

### Fix: callee-`Input` dependency tracking missed an unread or failed callee

`readCalleeInput` now reports a dependency for a callee it could not read
(the file does not exist yet, or exists only as an unsaved editor buffer) and
for every probed candidate path an unresolved specifier tried — an editor
retrying the same compile with `withCalleeInputSources` can now resolve
through those exact candidates instead of repeating the untyped fallback
forever. `probeFile` also checks the active source-override map, so an
unsaved buffer for a brand-new `.mx` file resolves like a saved one.

`TranslateError` gained an optional `dependencies` field: `compileSource`
now attaches every callee it resolved before a compile error was raised, so
a failing compile (e.g. "missing required attribute tag") still reports its
dependencies instead of none — previously a failed compile silently wiped a
dependency edge a prior *successful* compile of the same document had
recorded, breaking the next re-diagnosis.

### Breaking: body-only fallbacks are renderable (decision 108)

An attribute-tag property on an untyped, unresolved, or dynamic callee now
uses the bare `renderable` shape when none of its occurrences has attributes
or nested attribute tags. One such occurrence keeps the whole property
`data`; cardinality and declared `Input` shapes are unchanged. Custom-tag
transform rebuilds apply the same inference.

### Breaking: attribute-tag lowering carries declared shape and control flow

`AttributeTag`, `Component`, `HostTag`, and `Ir` gained required fields for
attribute-tag source spans, nested/control-flow trees, callee-aware property
plans, and host capability/import metadata. Hosts must consume these fields
instead of reconstructing attribute-tag shape from the flat list.

### Feature: syntactic callee `Input` resolution for attribute tags (decisions 106 and 107)

Core now exports `readCalleeInput`, which synchronously resolves a component
target and reads its exported `Input` declaration from `.mx`, TypeScript, TSX,
or JavaScript modules. It recognizes literal `AttrTag` declarations, follows
bounded same-file and type-import aliases, reports invalid configurations at
callee spans, and recursively describes nested attribute tags declared inside
`attrs`.

`CompileResult` now includes `dependencies: string[]`, containing every callee
and followed type-import file read during lowering. Integrations must use these
edges to invalidate callers when a callee's `Input` changes; the array remains
empty until lowering invokes the resolver.

Lowering now supplies authored import specifiers and discovered resolved paths
to the reader, reads the current unit's own `Input`, and uses declared callee
cardinality in end-to-end attribute-tag plans. Resolver scopes are per file;
file-qualified spans, re-exports, parse failures, missing resolution candidates,
and dependency edits participate in diagnostics and cache invalidation.

Dynamic tag calls now reject arguments combined with attributes, attribute
tags, or body content using Marko's positioned diagnostic. This prevents a
host from forwarding the arguments while silently dropping the rest of the
call shape; argument-only claimed host tags still retain their `args`.

### Breaking: an element's `on<Name>`/`on-<exact>` attribute lowers to a new `event` attr kind

An attribute on an **element** matching `/^on[A-Z-]/` **whose value is an
expression** is now lowered to an `Attr` of kind `"event"` carrying the source
spelling (`name`), the resolved DOM event name (`event`), the handler `Expr`
and a `nameSpan` — instead of the `dynamic` prop it used to be. The
attribute-method form (`onClick() { … }`) lowers to the same kind, with an
arrow-function `Expr`.

**The value has to be an expression.** A bare `<div onClick>` is HTML's
spelling of `true` and stays a `boolean` attribute; `<button
onClick="alert(1)">` is an ordinary HTML attribute string and stays `static`.
MX does not invent a policy against inline handler strings — it only stops
*creating* one from a function. (What the html host does with such a string is
phase B's decision.) `on<Name>` lowercases everything after `on`
(`onClick` → `click`, `onDblClick` → `dblclick`); `on-<exact>` is verbatim
(`on-my-event` → `my-event`). The rule is Marko's own, so an MX template and
the equivalent Marko template bind the same event, and every host now
recomposes its own spelling from one resolved name rather than re-deriving it.

**Why it is breaking for hosts:** `Attr` is a discriminated union every
emitter switches on, so a host that does not handle `"event"` no longer
type-checks. That is deliberate — the core's rule is that a host which cannot
express a kind must say so, never silently drop it. In this release every
in-tree host handles the kind with a **temporary passthrough**, so output is
unchanged on every host and oracle; each host's real emission (and its
rejections) follows in phase B.

Reproducing the old output means reproducing *which branch* the old `dynamic`
path took, not merely its most common one. On Angular that is visible: base
matched `on<Name>` against its own `EVENT_NAME` (`/^on[A-Z]/`) and routed it
through `IRREGULAR_EVENTS`/`domEventName`, while `on-<exact>` never matched
that regex (a dash is not a capital) and fell through to a plain `[name]=`
binding — so `on-my-event=f` emitted `[on-my-event]="f"`, and the passthrough
emits exactly that. The passthrough therefore keeps reading `attr.name`, not
the new `attr.event`: the two disagree precisely for `onDoubleClick`
(`dblclick` from Angular's table, `doubleclick` from core). Phase B switches
every host to `attr.event` and deletes `IRREGULAR_EVENTS`.

**Only on an element.** On a component call, a `<define>` call, a custom tag, a
host tag (`<try onClick=…>`) or an attribute tag, an `on*` attribute stays a
`dynamic` prop, because it is the callee's own prop contract rather than a DOM
event.

**Behaviour change for authors:** MX has no aliases. `onDoubleClick` lowers to
`doubleclick`, a nonexistent DOM event, and core raises a **non-rewriting**
warning positioned at the attribute name (`` `onDoubleClick` is not a DOM
event; did you mean `onDblclick` ``). Checked against `lib.dom.d.ts`, only
`onDoubleClick`, `onDragExit` and `onEncrypted` are affected; every other React
camelCase spelling already lowercases to the real DOM name. A template relying
on Preact's case-preserving custom events (`onMyEvent` → `MyEvent`) changes
meaning — it now lowercases to `myevent`, and the author must write
`on-MyEvent`.

`on:*` and `oncapture:*` are unchanged: core gives them no meaning and they
reach the host through the existing modifier hook.

### Phase B: hosts emit from the `event` kind (decision 101)

The phase-A passthroughs are replaced by each host's ruled emission,
recomposed from the one source of truth (`attr.event`, the DOM name):

- **Solid and the Preact/hono targets** emit `on` plus the capitalized DOM
  name — `click` → `onClick`, `dblclick` → `onDblclick` (capitalize-first) —
  so `onDblClick` and `on-dblclick` produce byte-identical output, and those
  runtimes lowercase the prop at bind time. **React is a lookup, not a
  derivation:** its prop names are camelCase data from react-dom's own
  registration table (`simpleEventPluginEvents`), which no rule can reverse
  (`keydown` → `onKeyDown`, `timeupdate` → `onTimeUpdate`), so the React
  target vendors the list plus the registrations outside it
  (`buildReactEventPropNames` in `packages/hosts/react/src/target.ts`,
  react-dom 19.3.0) and a drift test compares it against the installed
  react-dom. A custom DOM event a JSX
  prop cannot spell (`on-my-event`) is a uniform positioned error on all
  three naming the `ref` route, even though Preact alone could carry it.
- **Angular** emits `(${attr.event})="(handler)($event)"` for both
  `on<Name>` and `on-<exact>` — custom events bind verbatim — and maps a
  lowercase expression `onclick=fn` to `(click)`. The host's invented
  `IRREGULAR_EVENTS` table is deleted; `onDoubleClick` now emits
  `(doubleclick)` under core's warning, never a rewrite. Component `on*`
  attributes stay ordinary `[prop]` inputs (no `@Output()` inference).
- **html and astro** reject an expression-valued event attribute: an event
  handler requires a runtime, and both targets render once to a string /
  static markup. Previously html silently emitted dead inline JS. A
  *string*-valued `onclick="…"` stays an ordinary static attribute on every
  host — MX does not invent a policy against inline handler strings.
- **`on:`/`oncapture:`** are rejected on every host with a per-prefix fix-it
  naming `on-<exact>` (replacing the shared JSX emitter's wrong class-shaped
  hint and html's nonsense object suggestion).

`on-` with no event name after the dash is a positioned error (`` `on-` needs
an event name (`on-<event>`) ``) rather than a silently empty event name.

### `discoverProjectTags` reports host-module files under `tags/` as a diagnostic instead of throwing

`indexDirectory` (and therefore `scanCustomTags` and `discoverProjectTags`) now reports host-module files under `tags/` (like `.ng.mx` or `.solid.mx`) as a scan diagnostic rather than throwing, allowing the rest of the project's tags to be successfully discovered.

`indexDirectory` (shared by `scanCustomTags` and `discoverProjectTags`) used
to reject only `.solid.mx` under `tags/`; a `.ng.mx` file (the Angular host's
per-region file kind) was indexed as an ordinary tag instead, since it does
end with `.mx`. Both are now recognized as host module files — a different
file kind, not a tag template — via a small allowlist of host segments
(`solid`, `ng`), and rejected with the same generic, positioned message:
`` `<name>` is a host module file, not a tag template; tag templates are
`.mx` ``. The allowlist is deliberately closed rather than "any second dotted
segment before `.mx`", since `TAG_NAME_RE` allows dots in an ordinary tag
name and `tags/my.icon.mx` is meant to stay the valid tag `<my.icon>`. `.amx`
is unaffected either way — it carries no `.mx` suffix and is silently ignored
under `tags/`, as before.

### Breaking: a bare `${expr}` line is a dynamic tag, not a text placeholder

A standalone concise-position `${expr}` line (no attributes, no body) used to
lower to an escaped `Interpolation` whenever no host claimed `DYNAMIC_TAG`.
It now lowers the same way the tagged `<${expr} .../>` form does: a claiming
host still gets a `HostTag` (`shape: "bare"`), and an unclaiming host gets a
`Component` with `target: { kind: "dynamic", expr }` instead of a silent
interpolation — matching real Marko, which parses both shapes to the
identical `MarkoTag` node and treats an expression-named tag as a dynamic
tag (see Marko's own `error-dynamic-tag-name` fixture). Previously, lowering
a bare, unclaimed dynamic tag with attributes or a body threw `"dynamic tag
name is not supported in a standalone template"`; that error is gone — every
host now either claims the tag or emits a dynamic component. Text on its own
line still needs the escape hatch, `-- ${expr}`; a placeholder inside an
HTML-syntax body (`<div>${expr}</div>`) is unaffected, since it parses as
`MarkoPlaceholder` and never reaches this code path. See `divergences.md`
and `AGENTS.md`'s "four Marko facts" for the full history.

### `Expr` gains a file-absolute span (core contract C4)

`Expr.span?: SourceSpan` carries file-absolute byte offsets of an
expression's own authored source text, filled by `exprOf` for every
construction site (attribute values, spreads, interpolations, `<for>`
sources and keys, `<const>`/`<return>` initializers, component call
arguments) and absent only for a synthesized `Expr` or a fabricated literal
default — never a fabricated span pointing at unrelated text. Additive: no
existing field changed shape. `mapping.ts` gains `mappedExpr(expr)`, a thin
wrapper over `mapped(expr.code, expr.span ?? null)`; no host adopts it in
this change.

### `printExpression` is now a public export

`printExpression(node: Node): string` — printing a Marko-owned expression
node back to source text with the same Babel generator instance that parsed
it (`@marko/compiler/internal/babel`'s `generator`, concise mode) — was
module-private to `compile.ts`. It is now exported from `@mxlang/core`'s
public entry, so a host no longer has to carry its own copy over a
different Babel instance's generator to get the same result. Additive: no
existing export changed shape, and `newCtx`'s `generate` parameter is
unchanged — a caller still passes it explicitly. `@mxlang/solid` switched
its two `newCtx` call sites from its own `generateExpression` (over
`@babel/generator`) to this export and dropped that dependency; no output
change — `@babel/generator` and Marko's bundled generator were verified
byte-identical across the node kinds `.solid.mx` compiles through this
path.

### `Define`/`For` gain file-absolute name and param spans

`Define.nameSpan?: SourceSpan`, `Define.paramSpans?: Array<SourceSpan |
undefined>`, and `For.paramSpans?: Array<SourceSpan | undefined>` extend
C4's span convention to `<define>`'s own name and params and a `<for>`'s
params — the file-absolute byte offsets every other source-derived IR run
already carried, filled at `lowerDefine`/`lowerFor` and `undefined` only for
a param or name node with no authored `loc`. Additive: no existing field
changed shape, no emitter change required.

### `mx.tags[].hosts` now filters discovery

`getCustomTags`/`scanCached`/`scanCustomTags` accept an optional `host` in
their options (`"html"`, `"astro"`, `"solid"`, `"preact"`, `"react"`,
`"hono"`, `"angular"`). A `DiscoveredTag` now carries `hosts` from the
`mx.tags` entry that declared it, and a tag whose `hosts` excludes the
passed-in `host` is left out of both `ScanResult.tags` and `customTags`
entirely. No `hosts` on the entry (or no `mx.tags` entry at all, as with
every local `tags/` directory) means visible to every host. Every built-in
integration now passes its own host name when it scans.

`@mxlang/preact`'s `export { getCustomTags } from "@mxlang/core"` is a
passthrough for `@mxlang/react` and `@mxlang/hono`'s Bun loaders to call with
*their own* host name (`"react"`, `"hono"`) — it is not itself a call site
and stays unhosted by design, the same as importing `getCustomTags` directly
from `@mxlang/core`. `mx-tsc` is covered transitively: it runs the same
language plugin as the tsserver plugin (`@mxlang/typescript-plugin`), whose
`mx-language.ts`/`language.ts`/`amx-language.ts` call sites already resolve
and pass a host (see above).

### `discoverProjectTags`: project-wide tag enumeration

`discoverProjectTags(projectDir, options?)` enumerates every tag reachable
inside a project — every `tags/` directory found walking down from the
root, plus the root `package.json`'s `mx.tags` entries — the counterpart to
`scanCustomTags`'s single-file upward walk. Excludes `node_modules`,
dotdirectories, and nested packages. Accepts the same `host` filter.

The walk follows symlinked directories (a symlinked `tags/` directory is
discovered, and any directory reached only through a symlink is walked into
normally), guarded against symlink cycles so a self-referential link cannot
recurse forever.

### Tolerant, cached `package.json` reads

A broken `package.json` no longer silently drops `mx.tags`: the previous
good manifest stays in force, and one positioned diagnostic is reported per
broken revision (not per scan). Manifest reads are now cached by path and
mtime.

### TypeScript 6.0.3, and `typescript` as a peer dependency

The repo builds and typechecks on `typescript@6.0.3` (from `5.9.3`).

`@mxlang/tsc` and `@mxlang/typescript-plugin` now declare
`peerDependencies.typescript: ">=5.9.0 <7"` instead of an exact pin. TypeScript
must come from the consumer's project: the TS plugin is handed the `ts` object by
tsserver and `mx-tsc` passes `require('typescript')` to Volar's `runTsc`, so a
second nested copy breaks `instanceof` across that boundary. Both keep an exact
`devDependencies.typescript` so CI stays pinned.

`@mxlang/language-server` declares no `typescript` peer. It has no reference to
`typescript` in its source at all — TypeScript is only its build tool, emitting
`dist/*.d.ts` — so it keeps an exact `devDependencies.typescript` and nothing
else, rather than making consumers resolve a module it never loads.

The bump itself needed one source change: `packages/hosts/angular`'s
`tsconfig.build.json` now sets `rootDir: "src"` explicitly. TS 6 no longer
infers a common source directory when a build config and its base config
disagree about it (`TS5011`). No other package was affected, no deprecation
warning was reported anywhere in the build, typecheck, test or oracle runs, and
emitted `.d.ts` output is unchanged. The full TS 6 findings — and what they do
and do not imply for TS 7 — are in `notes/investigations/ts7-go-impact.md` §7.

### `<return>` and `/var`: a tag hands one value back (decision 95)

A template may end with `<return value=EXPR/>`, and a caller binds that value
with `/var`:

```marko
<!-- tags/counter.mx -->
<span>${input.start}</span>
<return value=input.start + 1/>
```

```marko
<counter/next start=41/>
<p>${next}</p>
```

- **`<return>` is value only.** Marko also accepts `valueChange`; MX 1 ships no
  two-way channel, so that attribute is rejected by name rather than accepted
  and dropped.
- **At most one per template, at the top level only.** Not inside a native tag,
  `<if>`/`<else>`, `<for>`, an attribute tag or a `<define>`. A returning tag
  returns unconditionally, which is what makes its signature a single shape
  rather than `T | undefined` per path — and because a unit compiles without
  seeing any of its callers, no call site can widen it. The grammar is Marko's,
  ported from its own `<return>` translator with MX wording; all eleven of its
  compile-time error fixtures have a counterpart test.
- **`<return>` in a page is legal** and means the same thing: a page is a module
  that returns a value nobody reads yet. It used to be a hard error on the html
  and JSX hosts, on the grounds that a compiled template "has no parent to
  return to" — true only while a tag was expanded into its caller.
- **breaking:** a unit that declares `<return>` changes its export shape. On
  html and the JSX hosts the default export returns `{ value, output }` rather
  than the output alone; on Solid the value comes back through a generated
  callback prop, because a Solid component's return value is its view. A unit
  with no `<return>` is unchanged. Astro renders an MX component through its
  own renderer, which unwraps the pair there.
- **`/var` is top-level-only on the JSX hosts and Solid.** Those targets lower
  `<if>` and `<for>` to *expressions* — a ternary, a `.map` callback, a `<For>`
  render prop — so a callback scope has no statement position to hold the
  binding, and hoisting the call out of it would read bindings that do not
  exist there and run once for a body rendered N times. Writing one there is a
  positioned error naming the tag; the call itself, without `/var`, works
  everywhere. html and Astro `.mx` support the nested case. Lifting the
  restriction is MX 2 work.
- **`/var` is not supported in a `.amx` file**, which has no statement position
  of its own; a `.amx` template may still *call* a returning tag and render its
  output.
- **A returning unit on a JSX host may not import hooks.** It is invoked as a
  plain function rather than mounted, so Preact's and React's hook dispatchers
  would bind its hooks to the *calling* component's hook list: order-dependent,
  broken under a conditional or looped call, and `useContext` reading the
  caller's position in the tree. Importing a `use*` binding from
  `preact/hooks`, `preact/compat`, `react` or `hono/jsx` into a unit that
  declares `<return>` is a compile error. Solid is unaffected — its callback
  prop keeps the unit a real component.
- **The Solid binding is one-shot, not reactive.** It holds the value from the
  single invocation that produced it, which matches `/var`'s meaning on every
  other host — but a Solid author may reasonably expect a signal, so a tag
  wanting reactivity should return an accessor for the caller to call.
- **The binding's type is the `<return>` expression's inferred type**, and a
  wrong prop at a discovered tag's call site is a TypeScript error at the
  caller's own position, through the tag's `export interface Input`.
- Three positioned diagnostics replace what would otherwise be `undefined` or a
  run-time crash: `/var` on a tag whose template has no `<return>`; a `/var`
  read outside its declaring block (MX rejects the escape rather than hoisting
  the binding into a getter as Marko does, which would change its type); and a
  read before the call that binds it.

### A custom tag's template is a compilation unit (decision 95)

A discovered template tag (`tags/icon.mx`) is no longer expanded into its
caller. It compiles through the same per-file pipeline a page uses, into a
module, and the caller emits an injected `import` plus an ordinary component
call — the shape an explicitly imported tag already produced on all six hosts.

- **breaking:** **a tag's `static` block now runs once per _process_, not once
  per calling module.** Its statements live in the tag's own module and are
  evaluated at import time, which is the module system's rule and Marko's own
  model. This is observable for any tag whose `static` block has side effects
  (a counter, a registration, an allocation): previously each calling module
  re-ran it, and now the first import does. A tag that needs per-call work
  should do it in the template body rather than in `static`.
- **breaking:** a template's `import`s no longer hoist into the caller's
  module, so the "same local name from a different module" error is gone along
  with the merge that raised it.
- **added:** `input` is a real parameter rather than a substituted name. A
  template may read an attribute any number of times (the caller's expression
  is evaluated once, at the call), accept a spread, use `input` as a value, or
  destructure it — every limit the substitution engine carried is gone.
- **added:** a tag file may export anything, and its `export interface Input`
  is now the tag's public type, typing the call site through the import.
- **added:** a tag may call itself; a module importing itself is legal ESM, so
  recursion terminates on the tag's data rather than on a compiler depth cap.
  **Mutual and self cycles between tag templates are now legal** rather than a
  compile error naming the path: two templates that call each other are an
  ordinary module cycle, and the unit mid-compile is recorded as `pending` so
  the metadata lookup terminates. Deliberate — the cycle detector existed only
  because inlining could not terminate.
- **added:** `parseOptions.openTagOnly` with a body is a positioned MX error at
  the call site (`` `<x>`: does not accept content ``) rather than a Marko
  parse error; `<@content>` on a tag call is rejected.
- **added:** compiling a tag unit caches `{ readsContent, attributeTags }`, so
  a body passed to a tag that never reads `input.content` still warns at the
  call site — MX's improvement over Marko, preserved across the rewrite.
- **removed:** the template expansion engine — `input` substitution, hygiene
  renaming, caller-side import/static merging, the expansion depth and node
  caps, and the template cycle detector. A tag being a separate module makes
  each of them unnecessary rather than merely unused.
- **fixed:** a discovered tag whose template contains a `static` block no
  longer crashes the compiler with `unexpected module-level node kind "Static"
  in the body walk`.
- **added:** `Import` carries `synthesized`, plus `specifier` and
  `resolvedPath`, set only on an import the compiler minted for a discovered
  tag. They exist for one host: a `.solid.mx` MX region is an *expression* with
  no module scope of its own, so `@mxlang/solid` now splits its
  module-level-statement rejection by **origin** rather than by kind. An
  authored `import`/`static`/`export` inside a region is still the same error;
  a synthesized one is returned on `CompileSolidMxResult.hoistedImports`, and
  `@mxlang/parser` writes it into the surrounding TypeScript module — once per
  **resolved path**, reusing the module's own authored default import of the
  same file when present, and never reusing a *type-only* import (it binds no
  runtime value) or one shadowed by a scope enclosing the region (the reused
  name would resolve to the shadow). This closes the last `oracle:custom-tags`
  skip: the gate is
  **24/24 with none recorded**. Every other host emits both kinds identically
  and ignores the flag.
- **breaking:** **every emitted module's default export is now named after its
  file** — `icon.mx` emits `export default function Icon(…)`, `table-of.mx`
  emits `TableOf` — on html, the shared preact/react/hono emitter, and
  `compileSolidUnit`. `Ir.exportName` carries the derived name, re-minted if it
  collides with anything the file already binds. This is observable for any
  consumer that matched the compiled module's export line as *text*: the
  name varies per file now, so a matcher must read it back rather than pin
  `render`. Four in-tree matchers were updated accordingly.
- **added:** **a self-recursive tag calls its own export, with no self-import**
  (design invariant §7.5-7). When a discovered tag's resolved path is the file
  being compiled, the caller emits a call to the module's own named
  declaration rather than `import $mx_Tree1 from "./tree.mx"`. Importing a
  file into itself is legal ESM and did work, but it is a module importing a
  binding it already has. The `tree` oracle fixture covers it on all six
  hosts, three levels deep.
- **added:** `@mxlang/solid` gains `compileSolidUnit`, a whole-file entry point
  beside the region entry point `compileSolidMx`. A tag unit is a file, so its
  module-level statements are placed rather than rejected. It **silently drops
  `export interface Input`** rather than emitting it — Solid's compiler takes
  source text and has no TypeScript frontend, so a type declaration there is a
  downstream syntax error. This is deliberate and pinned by a test, but it is
  an asymmetry worth knowing: the region path *errors* on an authored
  `export interface Input` while the unit path accepts and ignores it. Typing a
  unit's props is phase 3, through the same virtual-file projection the
  TypeScript plugin already does for `.solid.mx`.

- **Fix (marko-parity-trio, `<for>` `by=`/`key=`):** a **string** `by=` outside `of=` and a `key=` on `<for>` are compile errors now, matching Marko 6.3.51 (`runtime-tags/src/translator/core/for.ts`), which refused both and MX accepted both in silence — the S8 silent-drop class, because a `<for>` reads nothing under either name. The string `by` is reported at the quoted key it refuses, with the fix-it for that loop's form (`by=(key, value) => …` for `in`, `by=(index) => …` for `to`/`until`); `key=` is reported at the attribute, before the string check, with Marko's `by=` redirect. `by="id"` on `of=` keeps working on every host, including Angular's `track p.id`.

- **Fix (marko-parity-trio, `:modifier`):** `<div :foo="y"/>` is accepted, with Marko's own meaning. Marko's parser (`babel-plugin/parser.js`, `onAttrName`) splits an attribute name at its last `:` and fills an empty head with `value`, so this is one attribute literally named `value:foo`, which Marko compiles and renders as `<div value:foo=y>` — while every *other* modifier (`class:active`) is refused by Marko's taglib and still is here. Both spellings (`:foo` and `value:foo`) are the same attribute, and a valueless one (`:foo`) lowers to the empty string rather than to `true`, because HTML's valueless attribute is an attribute present with an empty value (React drops a `true` here with a non-boolean-attribute warning; Hono writes `"true"`). No host hook sees this form any more: it takes the ordinary attribute path, so each host emits the name in its own vocabulary.

- **Fix (marko-parity-trio, tag-argument position):** a "tag arguments `(...)`" diagnostic is reported at the **argument**, not at the tag. Marko points at `args[0]` (`assertNoArgs`), so `<button (click)="go()">` is reported under `click`; MX pointed at `<button`, one token left of the thing the error is about. The structured `line`/`column` stay 0-based (ruling #227), so this is a 1-based column of 7 for that source. The message and the `onClick=` fix-it are unchanged.
