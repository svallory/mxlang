# @mxlang/react

## Unreleased

- **Fix, visible emitted-code change (dynamic-tag-return-unit-object-object / dynamic-tag-var-silent-drop, decision 189):** same as Preact (shared emitter and compiler): a compiled unit that declares `<return>` now exports the output only; callers that read the pair use `Unit.render(props).value`. No alias. The pair moved to a `.render(props)` render path, so a dynamic tag (`<${Counter}/>`, directly or through a `.ts` barrel) renders the body where it threw "Objects are not valid as a React child"; `/var` reads the pair off `.render`, and a `/var` on a dynamic tag binds through `__mxDynamicPair` (core's `bindsDynamicTagVar` opt-in), refused inside `<for>`/`<if>`. Also Preact's r2 fix: a dynamic `/var` call with tag arguments renders its body, and the `/var` statement no longer emits `[object Object]`.
- **Fix (dynamic-tag-var-silent-drop, core):** a tag variable a host cannot bind (`/n` on a `.ts` component anywhere) is reported at the `/var` itself, not at the whole tag. Position only; binding and message unchanged.

- **Fix (routed-template-call-namespan):** a discovered tag's call maps its name span, so a type error on it (a missing required prop) lands on the tag name, not at 1:1 marked MX's. Same as Preact (shared emitter). No emitted code changes, only the source map.

- **Fix, behaviour change (unresolved-tags-dir-diagnostic, decision 172):** a tag Marko's lookup resolves to an `.mx` template (a `marko.json` entry) is imported from the path it was found at (`resolveDiscoveredTagModule`), bound as core's `_x` rather than `__mxX`; a `.marko` tag is core's one error, not an import of `./tags/<name>.marko`.

- **Fix (statement-followup, decision 168):** the error for JSX in a `static`/`export` statement is MX's own message at the `<` (was Babel's "Unterminated regular expression."); a decorated `static class` is accepted again.

- **Fix, behaviour change (statement-tags, decision 168):** statements parse as statements (typed functions, `<T,>`, JSX and atoms in a `static`/`export` line now compile). `server` now fails with a positioned error where it was silently dropped; `client` keeps its error; `class { … }` is a positioned not-supported error. React region files behave the same.

- **Fix (jsx-method-shorthand, decision 167):** an attribute method shorthand is emitted as a `function` / `async function` expression, and a body holding `) {` is valid JavaScript again (shared emitter, see `@mxlang/preact`). **Behaviour change:** `this` inside the method is the function's own, not lexical. Render-locked by `method-attr.test.ts`.

- **Fix (jsx-handler-prop-names, decision 161):** handler props come from a closed table of the names `@types/react` declares (`reactEventPropNames`, new export with `REACT_DECLARED_EVENT_NAMES`), checked both ways against the installed types and against react-dom's registrations. **Behaviour change:** a DOM event the types declare no handler for is a compile error instead of an `on` + capitalized prop: `on-fullscreenchange`/`on-fullscreenerror` (react-dom binds them, the types reject them), `on-search`, `on-command`, `on-formdata`, `on-animationcancel`, `onMouseWheel`, `on-scrollsnapchange` and any other unlisted name. The authored `onDoubleClick` emits React's declared `onDoubleClick` (was `onDoubleclick`, which React never bound). Every declared name emits as before. `src/event-names.test.ts` fires keydown/keyup/mousedown/dblclick/focusin at the emitted props through react-dom in jsdom.

- **Fix (jsx-handler-prop-names, decision 161):** the type-check-only handler wrapper ends in `as any`, so a mistyped handler is reported once (TS1360, mapped) instead of also as an unmapped TS2322 on the JSX prop. Emitted output is unchanged.

- **Fix (native-tag-binding-capture, decision 164):** a lowercase tag is a native element whatever `import` or `<define>` binding of that name is in scope (shared emitter, see `@mxlang/preact`). A warning is raised at the tag.

- **Fix, behaviour change (jsx-define-call-drops-attrs, decision 160):** a `<define>` called with attributes (`<Row n=1/>`) hands the define's first param one object of the attributes, spreads, attribute tags and `content`, as Marko 6.3.51 does (`{}` when the call carries none). It used to emit `Row(undefined)`, which compiled clean and crashed at render. Both `|p|` and `|{ n }|` read it, whole-file and in a `.react.mx` region. A call with tag arguments is unchanged (decision 109); a define with no params still ignores the attributes. **Behaviour change (decision 160 withdraws the per-param name lookup, 4ba13a4ea):** the old call looked each param up by name (`<define/Card|title, head|>` + `<Card title="a"/>` bound `title` to `"a"`); that source now binds `title` to the whole object and `head` is `undefined`, as in Marko, so destructure (`|{ title, head }|`). Core warns at the call tag when a define with 2+ params is called without arguments but with attributes, attribute tags or a body. Render-locked by `define-call-attrs.test.ts`.

- **Changed (jsx-define-call-drops-attrs, decision 160):** the host declares `defineCallPassesAttrs` (whole-file and region), which turns on core's multi-param `<define>` warning. An attribute tag passed to a `<define>` target is emitted untyped: a define's param type depends on inference, so the `Parameters<typeof Row>[0][...]` typing a named component's attribute tags get is not applied.

- **Added (react-region, decision 154):** `.react.mx` region files: TSX with MX regions, as `.solid.mx` is for Solid. The `react-jsx` descriptor gains the `react` file kind (`compileRegion`, `readCalleeInput`, language id `reactmx`), and `compileReactRegion` is exported. A region renders what the same markup renders in a whole-file `.mx`; hooks live in the surrounding component. In a region, `<const>` and module-level MX (`import`, `static`, `export`, `Input`, `<return>`) are errors at the statement, and `<let>`/`<effect>`/`<id>`/`<lifecycle>` name only the hook in the surrounding component (`reactRegionDeclarations`). **Behaviour change:** a `*.react.mx` file is no longer a whole-file `.mx`; it is a region file.

- **Fix (html-imported-return-tag-object-object):** an imported `.mx` tag that declares `<return>`, called without `/var`, renders its body and drops the value on this host too (the call now carries `returnsValue`, so the shared emitter unwraps `.output`). Render-locked by `imported-return-render.test.ts`.

- **Fix (jsx-textarea-value-content, decision 149):** `<textarea value=x/>` renders the value as escaped content, as Marko 6.3.51 does: `null`/`undefined`/`false`/`true` render nothing, `0` and `""` are kept, a leading newline is doubled for the server, a later `value` beats an earlier spread's, and a spread's `value` yields to a body. An explicit `value` together with body content is the compile error "A textarea cannot have both a value attribute and body content." A runtime-resolved `<${tag} value=…/>` that is a textarea takes `value` as content and rejects `content`. React keeps a controlled `value` prop (react-dom writes the content and the leading-newline double itself; a client update still changes the text, as before).

- **Fix (jsx-primitive-attr-parity):** primitive attribute values on native elements render as Marko 6.3.51's html output does, on direct, merged and spread paths: `false`/`null`/`undefined` omit (`data-x=false` no longer prints `"false"`), `true` is a bare attribute, `class`/`style` falsy primitives omit, direct `input.checked` is presence-only, and Hono `style=null` no longer throws. React prints boolean properties as presence only and refuses a literal string `style` in a spread at compile time (divergences.md). Shared normalization in `@mxlang/preact`, reused by react and hono; component props are unchanged.

- **Fix (jsx-text-entities, round 2):** shared JSX emission preserves decoded control references, including newline references at the start/end of text, instead of JSX-trimming or collapsing them. Pinned by real React rendering.

- **Fix (marko-parity-trio, `:modifier`):** `<div :foo="y"/>` compiles to the JSX attribute `value:foo={y}`, Marko's own attribute (MX previously rejected it).

- **Fix (jsx-text-entities):** authored entities in text render as Marko 6.3.51's browser-decoded text (`&copy 2026` → `© 2026`, `&check;`, `&lt`, `&#123`), through the shared emitter's HTML5 decode-and-re-emit; see `@mxlang/preact`.

- **Fix (preact-html-comment-literal-element):** `<html-comment>` is now a positioned compile error (JSX has no comment node) instead of silently emitting a literal `<html-comment>` element. See `@mxlang/preact`.

- **Fixed (pr6-s3a-tagtable-fixed):** A custom tag's `ctx.build.element(name)` without a `void` option is now void exactly when an authored `<name>` is: the target's `nativeTags` declares it void, else core's own HTML void elements. It defaulted to `void: false` before, so `ctx.build.element("br")` rendered `<br></br>` on `@mxlang/angular` and `@mxlang/astro` (`@mxlang/html` hid it by re-reading core's void names, which its emitter no longer does). An explicit `void` still wins (review 475 r3, decision 197). A void element built with children, by default or with `{ void: true }`, is now a compile error at the tag ("`<br>` is void and takes no children; pass { void: false } to emit an end tag"): `@mxlang/html` dropped those children silently; `@mxlang/angular` and `@mxlang/astro` emitted `<br>child</br>`; and the JSX hosts (`@mxlang/preact`, `@mxlang/react`, `@mxlang/hono`, `@mxlang/solid`) compiled it to `<br>child</br>` JSX, which React rejects at runtime.

- **Removed (pr6-s3a-tagtable-removed):** A `marko.json` (or `marko-tag.json`) taglib is no longer read (decision 197, PR 6 slice S3a). A tag only a `marko.json` maps (`template`, `renderer`, `tags-dir`) is an unknown tag like any other: `@mxlang/html`'s "Unable to find entry point for custom tag" error, the native element on Preact, React, Hono and Angular. It was imported and called before. With it go `@mxlang/html`'s and `@mxlang/preact`'s `resolveDiscoveredTagModule` implementations; the optional hook stays on `HostDeclarations` for a third-party target. A `tags/x.marko` file is still the decision 172 error, now found by core's own discovery on every host. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).

- **Changed (rename-package-families):** Renamed (decision 201, package families): `@mxlang/html` -> `@mxlang/target-html`; `@mxlang/target-registry` -> `@mxlang/targets`, now the umbrella (the registry, the html target's descriptor as `htmlTarget`, and the html target's full entry at `@mxlang/targets/html`); `@mxlang/react` -> `@mxlang/host-react`; `@mxlang/preact` -> `@mxlang/host-preact`; `@mxlang/solid` -> `@mxlang/host-solid`; `@mxlang/hono` -> `@mxlang/host-hono`; `@mxlang/astro` -> `@mxlang/host-astro`; `@mxlang/angular` -> `@mxlang/host-angular`. Imports, emitted runtime imports (`@mxlang/host-solid/...`) and `mx.target` package selection use the new names. The old names are deprecated on the registry at the next publish. `mx-angular build` still treats an output whose header reads `Generated by @mxlang/angular from` as generated, so files built before the rename are rewritten instead of refused. `@mxlang/data` is not renamed: the tree-ir-entry change deletes it (decision 204).

- **Fixed (define-call-trailing-object):** - html, preact, react, hono, solid: a `<define>` called with tag arguments **and** a body or attribute tags now binds the extras the way Marko does: the call appends ONE trailing object (`{ ...attributeTags, content }`) as its next argument, so it lands in the define's first unfilled parameter and every parameter after it reads `undefined` (a rest parameter stays empty). Previously the remaining parameters were filled *by name* from the attribute tags and body, so `<Row(1)><@b>2</@b></Row>` bound `b` to the attribute tag's value and a parameter named `content` received the body renderable; now that parameter receives the whole `{ b: … }` object (destructure it: `|a, { b }|`) and the body arrives under `content` inside the same object. When the tag arguments already fill every parameter, the extras are dropped, as in Marko. The no-argument call is unchanged (one props object into the first parameter). On solid, a rest parameter of a no-argument `<define>` call is no longer padded with `undefined` either.

- **Fixed (lowercase-local-component):** A lowercase tag naming a local binding is now Marko's own error, in core, on every target — same message verbatim, same position (the tag name): `Local variables must be in a [dynamic tag](https://markojs.com/docs/reference/language#dynamic-tags) unless they are PascalCase. Use `<${layout}/>` or rename to `Layout`.` The rule covers every local binding: a default or named `import` (a `.mx` tag module or a `.ts` value alike), a lowercase `<define>`, a `<const>`, a `<for>`/`<define>` tag param, a `static` declaration (`static const layout = 1` then `<layout/>`, plain or destructured), and an `export const`/`function`/`class` declaration. A core taglib name (`<debug>`, `<log>`) keeps its own routing — as in Marko — even when bound: no error and no "native element" warning. A native-element name stays native (silently for a value binding, with the existing warning for a tag binding); a registered custom tag, a taglib tag or a host claim still wins whatever is imported. `_`/`$`-prefixed names follow Marko's message, whose naive capitalization offers "rename to `_row`". Before, the error existed only for a tag binding (a `<define>` or a `.mx` default import) and in core's own wording ("`<layout>` is not a tag here…"), a lowercase **value** import (`import layout from "./layout.ts"` then `<layout/>`) was a silent pass on preact, react, hono, solid and astro (a literal lowercase element was emitted) and only html rejected it, through its own `rejectComponentTag` hook (now removed — core covers it). The `<const>`, `static` and tag-param forms fell to the unknown-tag path at best (html) or passed silently (the JSX hosts); a core taglib name bound by an import drew the local-variable error on the JSX hosts, where Marko compiles the tag. The message and position are measured on the stock parser (`@marko/compiler` 5.42.11 / `marko` 6.4.4): identical for a tag import, a value import, a `static const` local, an `export const` local, a `<const>` and a `<for>` param. The rest of the lowercase-tag rules are unchanged. One boundary, matching the existing import behaviour: a use *before* the `import`/`static`/`export` statement is not covered — bindings register in document order.

## 0.1.0 (unreleased)

- **Added (default-tag-contracts, decision 145):** the parent contract's `defaultTag` is the first rung for the unnamed tag (through `@mxlang/preact`).

- **Added (default-tag-ladder, decision 145):** the descriptor declares `defaultTag: "div"` (shared constant with Preact); `compileReactMx` takes `defaultTag` (`mx.react-jsx.defaultTag`).

- **Feat (default-tag-core, decision 145):** declares `resolveDefaultTag: () => "div"`, the interim answer for the unnamed tag until the registry ladder lands. Output is byte-identical.

- **Fix (attr-value-parity review):** shared JSX guards are hoisted once per module and reject ordinary function/symbol values with Marko debug text; event handlers and framework props remain exempt.

- **Fix (attr-value-parity):** ordinary native object values now throw Marko's diagnostic at render time, including final merged spreads and dynamic string tags; authored expressions are evaluated once. Component, class/style, controlled and framework-only props keep their existing contracts. Nested event/style prefix hints are corrected through the shared JSX emitter.

- **Fix (jsx-text-lt-unescaped):** text with JSX-significant characters (`<`, `>`, braces) is escaped in the generated TSX, so `<div>a < b</div>` compiles and renders `a < b` as Marko does, instead of failing downstream parsing. Authored entities decode the same as in a browser only for `;`-terminated numeric references and the HTML4 named set; HTML5-only names and unterminated legacy forms stay literal (known divergence, tracked separately). See `@mxlang/preact`.

- **Fix (scriptlet-hint-let-var):** the shared JSX declarations omit immutable `<const>` advice for `$ let`/`$ var`; React rejects `<let>`. `$ const` advice is unchanged.

- **Fix (jsx-whitespace-body-parity, decision 141):** same-line whitespace-only bodies now render one space when forwarded, through both imported components and discovered `tags/*.mx`. Uses core's host-independent body-presence correction; newline indentation stays absent. Pinned by React's rendered static markup.

- **Fix (jsx-intrinsic-prop-errors, decision 140 (b)):** native-element non-event prop errors now surface at the authored attribute name through the shared JSX emitter, including renamed `class` → `className` and `for` → `htmlFor`. Checks follow React's own JSX types; event handlers and runtime output are unchanged. See `@mxlang/preact`.

- **Added (jsx-handler-typing, decision 140):** `compileReactMx` takes the internal, tooling-only `typeCheck` option (see `@mxlang/preact`); runtime output is unchanged with it unset. **Effect on users (new errors on existing code):** in the editor and `mx-tsc`, native event handlers are now checked against `@types/react`, as in plain TSX. A handler annotated with a DOM event type (`onClick=((e: MouseEvent) => …)`, `(e: Event)`) is now an error, because React's synthetic events are not the DOM's; annotate with `React.MouseEvent<HTMLButtonElement>` or leave the parameter unannotated. Mistyped handlers, the bodies of shorthand handlers and valid `onDblClick`/`onKeyDown` handlers behave as described for `@mxlang/preact`.

- **Added (fix-hints-batch, audit item 14):** the unresolved-tag, event-binding, scriptlet and missing-attribute-value hints reach this host through the shared `@mxlang/preact` emitter and `@mxlang/core`.

- **Added, unstable (target-registry, decisions 129 and 132):** `./descriptor` subpath exports the `react-jsx` target descriptor (host `react`, `reactDeclarations`, `load()` returning `compileReactMx`). Adds `@mxlang/core` as a dependency for the descriptor's type. Nothing consumes it yet; see `@mxlang/target-registry`. The dialect now imports `createJsxDeclarations` through `@mxlang/preact/emitter` instead of the package root, so importing the descriptor stays free of preact's compile entry.

- **Fix (dup-attr-last-wins-core, decision 135):** a repeated attribute now emits only the last (behavior unchanged: JSX already kept the last). The earlier occurrence gets a positioned warning naming the surviving one. See `@mxlang/core`.

- **Breaking (jsx-dialect-rename, decision 132):** the shared JSX emitter's `Target` object is now `JsxDialect`, since "target" now means a registered output format. Renamed, no aliases: `Target` → `JsxDialect`, `preactTarget` → `preactDialect`, `reactTarget` → `reactDialect`, `honoTarget` → `honoDialect`, the `CompilePreactOptions.target` option → `dialect`, and `src/target.ts` → `src/dialect.ts`. No emitted-code change.

- **Fix (jsx-dynamic-body-text):** a text-only body forwarded through `<${input.content}/>` now renders as text, as in Marko 6.3.51, instead of an element named by the text (`<hello></hello>`). The generated callee preamble turns a string or number `content`/`children` (from an MX call site or a hand-written caller) into body content, with numbers via `String`; the preamble comes from `@mxlang/preact`, which this package reuses.

- **Fix (audit-02-for-by-parity):** `<for by=x.id>` (any read of a loop param in `by=`) is now a positioned error, as in Marko 6.3.51, instead of passing silently. See `@mxlang/core`.

- **Fix (audit-01-prop-attr-parity):** an attribute name outside Marko's grammar (`[prop]=`, `#ref`, `*ngIf`) is now a positioned "Invalid attribute name" error, as in Marko 6.3.51, instead of passing through. See `@mxlang/core`.

- **Fixed:** a `memo(Foo)`/`forwardRef(...)` value reached through the
  dynamic path (a local classified "unknown" under decision 116's local
  extension, or a `.tsx` value import) now renders correctly instead of
  throwing "Objects are not valid as a React child". React's `memo`/
  `forwardRef` return plain objects, not functions — the shared emitter's
  `mxDynamic` helper (`@mxlang/preact`) now recognizes any value carrying a
  `$$typeof` symbol as a component. See `@mxlang/preact`'s CHANGELOG and the
  spec's decision 116 section for the full detail.

- **Fixed (behavior change, decision 114 parity, `unresolved-tag-jsx-astro-angular`):**
  `<TotallyUndefined/>` — a capitalized tag with no import, binding, or taglib
  entry — now fails to compile with Marko's own error ("Unable to find entry
  point for custom tag `<TotallyUndefined>`.") through the shared JSX emitter
  (`@mxlang/preact`'s `emitter.ts`), instead of silently emitting a JSX
  component reference to nothing. See `@mxlang/preact`'s CHANGELOG for the
  detail.
- **breaking:** attribute tags now follow the callee-declared decision-106
  shape through the shared JSX emitter. The package exports `AttrTag<C>`
  specialised to `ReactNode`.
- **breaking:** decision 108 passes an untyped body-only attribute-tag prop as
  a bare React node. Any attributed or nested occurrence keeps that fallback
  property data-shaped; declared shapes and cardinality are unchanged.
