# @mxlang/hono

- **Changed (preact-region, decision 154):** the Bun loader declines `.preact.mx` (Preact's region file kind), as `@mxlang/html`'s does.

- **Added (hono-region, decision 154):** `.hono.mx` region files: TSX with MX regions, as `.solid.mx` is for Solid. The `hono-jsx` descriptor gains the `hono` file kind (`compileRegion`, `readCalleeInput`, language id `honomx`), and `compileHonoRegion` is exported. A region renders what the same markup renders in a whole-file `.mx`; hooks live in the surrounding component. In a region, `<const>` and module-level MX (`import`, `static`, `export`, `Input`, `<return>`) are errors at the statement, and `<let>`/`<effect>`/`<id>`/`<lifecycle>` name only the hook in the surrounding component (`honoRegionDeclarations`).

- **Changed (hono-region, decision 154):** **behaviour change:** a `*.hono.mx` file is no longer a whole-file `.mx`; it is a region file, and the Bun loader declines it.

- **Fix, behaviour change (jsx-define-call-drops-attrs, decision 160):** a `<define>` called with attributes (`<Row n=1/>`) hands the define's first param one object of the attributes, spreads, attribute tags and `content`, as Marko 6.3.51 does (`{}` when the call carries none). It used to emit `Row(undefined)`, which compiled clean and crashed at render. Both `|p|` and `|{ n }|` read it, whole-file and in a `.react.mx` region. A call with tag arguments is unchanged (decision 109); a define with no params still ignores the attributes. **Behaviour change (decision 160 withdraws the per-param name lookup, 4ba13a4ea):** the old call looked each param up by name (`<define/Card|title, head|>` + `<Card title="a"/>` bound `title` to `"a"`); that source now binds `title` to the whole object and `head` is `undefined`, as in Marko, so destructure (`|{ title, head }|`). Core warns at the call tag when a define with 2+ params is called without arguments but with attributes, attribute tags or a body. Render-locked by `define-call-attrs.test.ts`.

- **Changed (jsx-define-call-drops-attrs, decision 160):** the host declares `defineCallPassesAttrs` (whole-file and region), which turns on core's multi-param `<define>` warning. An attribute tag passed to a `<define>` target is emitted untyped: a define's param type depends on inference, so the `Parameters<typeof Row>[0][...]` typing a named component's attribute tags get is not applied.

- **Changed (react-region, decision 154):** the Bun loader declines `.react.mx` (React's region file kind), as `@mxlang/html`'s does.

- **Changed (bridge-host, decision 154):** the Bun loader's filter is built from its lookup (`mxFilter`), as `@mxlang/html`'s; unchanged with the package's own lookup.

- **Fix (html-imported-return-tag-object-object):** an imported `.mx` tag that declares `<return>`, called without `/var`, renders its body and drops the value on this host too (the call now carries `returnsValue`, so the shared emitter unwraps `.output`). Render-locked by `imported-return-render.test.ts`.

- **Fix (jsx-textarea-value-content, decision 149):** `<textarea value=x/>` renders the value as escaped content, as Marko 6.3.51 does: `null`/`undefined`/`false`/`true` render nothing, `0` and `""` are kept, a leading newline is doubled for the server, a later `value` beats an earlier spread's, and a spread's `value` yields to a body. An explicit `value` together with body content is the compile error "A textarea cannot have both a value attribute and body content." A runtime-resolved `<${tag} value=…/>` that is a textarea takes `value` as content and rejects `content`. Hono doubles the leading newline only where no `document` exists (`hono/jsx/dom`'s `render` accepts the emitted nodes and must not double); see divergences.md.

- **Fix (jsx-primitive-attr-parity):** primitive attribute values on native elements render as Marko 6.3.51's html output does, on direct, merged and spread paths: `false`/`null`/`undefined` omit (`data-x=false` no longer prints `"false"`), `true` is a bare attribute, `class`/`style` falsy primitives omit, direct `input.checked` is presence-only, and Hono `style=null` no longer throws. Shared normalization in `@mxlang/preact`, reused by react and hono; component props are unchanged.

- **Fix (jsx-text-entities, round 2):** shared JSX emission preserves decoded control references, including newline references at the start/end of text, instead of JSX-trimming or collapsing them. Pinned by real Hono rendering.

- **Fix (marko-parity-trio, `:modifier`):** `<div :foo="y"/>` compiles to the JSX attribute `value:foo={y}`, Marko's own attribute (MX previously rejected it).

- **Fix (jsx-text-entities):** authored entities in text render as Marko 6.3.51's browser-decoded text (`&copy 2026` → `© 2026`, `&check;`, `&lt`, `&#123`), through the shared emitter's HTML5 decode-and-re-emit; see `@mxlang/preact`.

- **Fix (preact-html-comment-literal-element):** `<html-comment>` is now a positioned compile error (JSX has no comment node) instead of silently emitting a literal `<html-comment>` element. See `@mxlang/preact`.

## 0.1.0 (unreleased)

- **Fix (default-tag-contracts r2):** the Bun loader reports an invalid contract `defaultTag` once at its declaration.

- **Added (default-tag-contracts, decision 145):** the parent contract's `defaultTag` is the first rung for the unnamed tag (through `@mxlang/preact`).

- **Fix (default-tag-ladder r2):** the Bun loader validates `mx.hono-jsx.defaultTag`; a rejected value is dropped and warned once at the `package.json` value.

- **Added (default-tag-ladder, decision 145):** the descriptor declares `defaultTag: "div"` (shared constant with Preact); `compileHonoMx` takes `defaultTag` and the Bun loader reads `mx.hono-jsx.defaultTag`.

- **Feat (default-tag-core, decision 145):** declares `resolveDefaultTag: () => "div"`, the interim answer for the unnamed tag until the registry ladder lands. Output is byte-identical.

- **Fix (attr-value-parity review):** shared JSX guards are hoisted once per module and reject ordinary function/symbol values with Marko debug text; event handlers and framework props remain exempt.

- **Fix (attr-value-parity):** ordinary native object values now throw Marko's diagnostic at render time, including final merged spreads and dynamic string tags; authored expressions are evaluated once. Component, class/style, controlled and framework-only props keep their existing contracts. Nested event/style prefix hints are corrected through the shared JSX emitter.

- **Fix (jsx-text-lt-unescaped):** text with JSX-significant characters (`<`, `>`, braces) is escaped in the generated TSX, so `<div>a < b</div>` compiles and renders `a < b` as Marko does, instead of failing downstream parsing. Authored entities decode the same as in a browser only for `;`-terminated numeric references and the HTML4 named set; HTML5-only names and unterminated legacy forms stay literal (known divergence, tracked separately). See `@mxlang/preact`.

- **Fix (scriptlet-hint-let-var):** the shared JSX declarations omit immutable `<const>` advice for `$ let`/`$ var`; Hono rejects `<let>`. `$ const` advice is unchanged.

- **Fix (jsx-whitespace-body-parity, decision 141):** same-line whitespace-only bodies now render one space when forwarded, through both imported components and discovered `tags/*.mx`. Uses core's host-independent body-presence correction; newline indentation stays absent. Pinned by Hono's rendered output.

- **Fix (jsx-intrinsic-prop-errors, decision 140 (b)):** native-element non-event prop errors now surface at the authored attribute name through the shared JSX emitter, checked against Hono's own JSX types. On the pinned Hono 4.6.20, lowercase `maxlength`/`tabindex` are typed; camelCase `maxLength`/`tabIndex`, unknown props such as `foo`, and `key`/`ref` remain accepted by its `any` attribute index signature, exactly as in plain TSX (lead ruling: host-native parity, not stricter MX types). Invalid `class`, `disabled` and `value` props now report. Event handlers and runtime output are unchanged. See `@mxlang/preact`.

- **Added (jsx-handler-typing, decision 140):** `compileHonoMx` takes the internal, tooling-only `typeCheck` option (see `@mxlang/preact`); runtime output is unchanged with it unset. **Effect on users:** in the editor and `mx-tsc`, native event handlers are now checked against Hono's own JSX types (the DOM's events), as in plain TSX: a mistyped handler is an error at the authored handler, and the bodies of shorthand handlers are type-checked. Hono declares `onDoubleClick` only, so `onDblClick=` is reported as it is in plain TSX.

- **Changed (refactor/target-open-set, decision 137):** the Bun loader excludes a dotted tag file name from the tag map with a positioned diagnostic, but leaves peer `mx.tags[].hosts` restrictions unresolved without a warning; only full-registry tooling validates host names (PR 3 round-2 ruling); package specifiers stay silent. The loader resolves its targets from this package's own descriptor unless a caller passes a lookup (`createHonoBunPlugin(targets)`).
- **Changed (refactor/target-open-set, decisions 129 and 132):** `compileHonoMx`/`compileHonoFile` accept `options.targets`, defaulting to this package's own descriptor (`honoTargets`).

- **Added (fix-hints-batch, audit item 14):** the unresolved-tag, event-binding, scriptlet and missing-attribute-value hints reach this host through the shared `@mxlang/preact` emitter and `@mxlang/core`.

- **Changed (amx-to-astro-mx, decision 134):** the Bun loader's file filter also declines `x.astro.mx`, Astro's template kind, as it already declines `x.solid.mx`.

- **Added, unstable (target-registry, decisions 129 and 132):** `./descriptor` subpath exports the `hono-jsx` target descriptor (host `hono`, `honoDeclarations`, `load()` returning `compileHonoMx`). Adds `@mxlang/core` as a dependency for the descriptor's type. Nothing consumes it yet; see `@mxlang/target-registry`. The dialect now imports `createJsxDeclarations` through `@mxlang/preact/emitter` instead of the package root, so importing the descriptor stays free of preact's compile entry.

- **Fix (dup-attr-last-wins-core, decision 135):** a repeated attribute now emits only the last (behavior unchanged: JSX already kept the last). The earlier occurrence gets a positioned warning naming the surviving one. See `@mxlang/core`.

- **Breaking (jsx-dialect-rename, decision 132):** the shared JSX emitter's `Target` object is now `JsxDialect`, since "target" now means a registered output format. Renamed, no aliases: `Target` → `JsxDialect`, `preactTarget` → `preactDialect`, `reactTarget` → `reactDialect`, `honoTarget` → `honoDialect`, the `CompilePreactOptions.target` option → `dialect`, and `src/target.ts` → `src/dialect.ts`. No emitted-code change.

- **Fix (jsx-dynamic-body-text):** a text-only body forwarded through `<${input.content}/>` now renders as text, as in Marko 6.3.51, instead of an element named by the text (`<hello></hello>`). The generated callee preamble turns a string or number `content`/`children` (from an MX call site or a hand-written caller) into body content, with numbers via `String`; the preamble comes from `@mxlang/preact`, which this package reuses.

- **Fix (audit-02-for-by-parity):** `<for by=x.id>` (any read of a loop param in `by=`) is now a positioned error, as in Marko 6.3.51, instead of passing silently. See `@mxlang/core`.

- **Fix (audit-01-prop-attr-parity):** an attribute name outside Marko's grammar (`[prop]=`, `#ref`, `*ngIf`) is now a positioned "Invalid attribute name" error, as in Marko 6.3.51, instead of passing through. See `@mxlang/core`.

- **Fixed:** the shared `mxDynamic` helper (`@mxlang/preact`, this package's
  own emitter) now recognizes a `$$typeof`-carrying host component object
  (React's `memo`/`forwardRef`) as a component rather than a plain data
  object. hono/jsx's own `memo`/`forwardRef` were already unaffected (real
  functions, unlike React's); React's raw object form imported directly into
  a Hono app remains unsupported regardless — measured, `hono/jsx`'s own
  `jsx()` runtime has no object-based component dispatch at all, with or
  without MX. See `@mxlang/preact`'s CHANGELOG and the spec's decision 116
  section for the full detail.

- **Fixed (behavior change, decision 114 parity, `unresolved-tag-jsx-astro-angular`):**
  `<TotallyUndefined/>` — a capitalized tag with no import, binding, or taglib
  entry — now fails to compile with Marko's own error ("Unable to find entry
  point for custom tag `<TotallyUndefined>`.") through the shared JSX emitter
  (`@mxlang/preact`'s `emitter.ts`), instead of silently emitting a JSX
  component reference to nothing. See `@mxlang/preact`'s CHANGELOG for the
  detail.
- **breaking:** attribute tags now follow the callee-declared decision-106
  shape through the shared JSX emitter. The package exports `AttrTag<C>`
  specialised to Hono's `Child`.
- **breaking:** decision 108 passes an untyped body-only attribute-tag prop as
  a bare Hono child. Any attributed or nested occurrence keeps that fallback
  property data-shaped; declared shapes and cardinality are unchanged.
