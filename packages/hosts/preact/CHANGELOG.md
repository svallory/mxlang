# @mxlang/preact

- **Fix (native-tag-binding-capture, decision 164 addendum 1):** a registered taglib tag (`tags/row.marko`) that shares its name with an authored import or `<define>` calls the taglib tag through core's binding (`import _row from "./tags/row.marko"`, `<_row …/>`), once, on Preact, React and Hono; it used to alias and call the authored import.
- **Fix (native-tag-binding-capture, decision 164):** a lowercase tag is a native element whatever `import` or `<define>` binding of that name is in scope (no more `__mxDynamic(span, …)` for an imported `span`); also applies to `@mxlang/react` and `@mxlang/hono`. A warning is raised at the tag.
- **Added (preact-region, decision 154):** `.preact.mx`, TSX with MX regions on Preact, is a built-in region file kind (segment `preact`, language id `preactmx`, diagnostic source `preactmx`): `compilePreactRegion` (exported; `targets` defaults to the package's own lookup) is the shared `compileJsxRegion` with Preact's dialect and the new `preactRegionDeclarations`, wired through the descriptor's `fileKinds` with the shared `readJsxCalleeInput` reader. **Behaviour change:** a `*.preact.mx` file stops being a whole-file `.mx`; a region renders what the same markup renders in a whole-file Preact `.mx`. Whole-file output is unchanged.

- **Fix, behaviour change (jsx-define-call-drops-attrs, decision 160):** a `<define>` called with attributes (`<Row n=1/>`) hands the define's first param one object of the attributes, spreads, attribute tags and `content`, as Marko 6.3.51 does (`{}` when the call carries none). It used to emit `Row(undefined)`, which compiled clean and crashed at render. Both `|p|` and `|{ n }|` read it, whole-file and in a `.react.mx` region. A call with tag arguments is unchanged (decision 109); a define with no params still ignores the attributes. **Behaviour change (decision 160 withdraws the per-param name lookup, 4ba13a4ea):** the old call looked each param up by name (`<define/Card|title, head|>` + `<Card title="a"/>` bound `title` to `"a"`); that source now binds `title` to the whole object and `head` is `undefined`, as in Marko, so destructure (`|{ title, head }|`). Core warns at the call tag when a define with 2+ params is called without arguments but with attributes, attribute tags or a body. Render-locked by `define-call-attrs.test.ts`.

- **Changed (jsx-define-call-drops-attrs, decision 160):** the host declares `defineCallPassesAttrs` (whole-file and region), which turns on core's multi-param `<define>` warning. An attribute tag passed to a `<define>` target is emitted untyped: a define's param type depends on inference, so the `Parameters<typeof Row>[0][...]` typing a named component's attribute tags get is not applied.

- **Added (react-region, decision 154):** the shared JSX region engine, `compileJsxRegion` (`@mxlang/preact/region`), which every JSX host wraps for its `.<segment>.mx` file kind, and `readJsxCalleeInput` (`@mxlang/preact/callee-reader`), their one callee reader (new dependency on `@mxlang/parser`). `createJsxDeclarations(name, { region: true })` is the region variant of the reactive-tag errors, naming only the hook in the surrounding component; whole-file messages and output are unchanged.

- **Fix (html-imported-return-tag-object-object):** an imported `.mx` tag that declares `<return>`, called without `/var`, renders its body and drops the value on this host too (the call now carries `returnsValue`, so the shared emitter unwraps `.output`). Render-locked by `imported-return-render.test.ts`.

- **Fix (jsx-textarea-value-content, decision 149):** `<textarea value=x/>` renders the value as escaped content, as Marko 6.3.51 does: `null`/`undefined`/`false`/`true` render nothing, `0` and `""` are kept, a leading newline is doubled for the server, a later `value` beats an earlier spread's, and a spread's `value` yields to a body. An explicit `value` together with body content is the compile error "A textarea cannot have both a value attribute and body content." A runtime-resolved `<${tag} value=…/>` that is a textarea takes `value` as content and rejects `content`. Preact doubles the leading newline only for the server (`typeof document`); see divergences.md. With a spread, an explicit `value` stays in the merged object so the later source wins, as Marko.

- **Fix (jsx-primitive-attr-parity):** primitive attribute values on native elements render as Marko 6.3.51's html output does, on direct, merged and spread paths: `false`/`null`/`undefined` omit (`data-x=false` no longer prints `"false"`), `true` is a bare attribute, `class`/`style` falsy primitives omit, direct `input.checked` is presence-only, and Hono `style=null` no longer throws. Shared normalization in `@mxlang/preact`, reused by react and hono; component props are unchanged.

- **Fix (jsx-text-entities, round 2):** re-emit every decoded C0 control character as a numeric reference so JSX whitespace trimming cannot turn `a&#10;b` into `a b` or drop boundary newlines. Rendered newline/tab regressions are covered; React and Hono share the fix.

- **Fix (marko-parity-trio, `:modifier`):** `<div :foo="y"/>` compiles to the JSX attribute `value:foo={y}`, Marko's own attribute (MX previously rejected it).

- **Fix (jsx-text-entities):** authored `&…` in text is now HTML5-decoded in the emitter and re-emitted as numeric character references, so JSX output equals Marko 6.3.51's browser-decoded text for every input. The decoder is `entities`' spec-exact `decodeHTML` (the tokenizer's "character reference in data" state), covering legacy no-semicolon names (`&copy 2026` → `© 2026`), HTML5-only names (`&check;`), and unterminated numeric references (`&#123`), which the JSX transform's narrower named-entity set used to leave literal. Every JSX-significant or non-ASCII character — including a decoded `&`, carriage returns, and multi-code-point entities, escaped per code point — becomes a `;`-terminated numeric reference the JSX transform always decodes back. `<style>` bodies are exempt: the HTML tokenizer applies no character references in raw-text elements. Adds `entities` 6.0.1 as a dependency. Shared with `@mxlang/react` and `@mxlang/hono`. Pinned by rendered parity tests against Marko + parse5 and by a `@mxlang/typescript-plugin` mapping test.

- **Fix (preact-html-comment-literal-element):** `<html-comment>` is now a positioned compile error — `an HTML comment (<html-comment>) cannot appear in a Preact component: JSX has no comment node…` — instead of silently emitting a literal `<html-comment>` element where Marko renders `<!--…-->`. Shared with `@mxlang/react` and `@mxlang/hono`.

## 0.1.0 (unreleased)

- **Fix (expression-values-unmapped-jsx-html):** the shared JSX emitter maps component prop values, component spreads, class objects, `${}` text and a lone escaped child to their authored source, so TypeScript errors inside them reach the editor and `mx-tsc` (preact, react, hono). Emitted text unchanged.

- **Fix (default-tag-contracts r2):** the parent contract's `defaultTag` is seen through `if`/`for`/`try` (shared with React and Hono); an invalid value falls through.

- **Added (default-tag-contracts, decision 145):** the parent contract's `defaultTag` is the first rung for the unnamed tag (shared with React and Hono).

- **Added (default-tag-ladder, decision 145):** the descriptor declares `defaultTag` (`DEFAULT_TAG`, `div`) and `createJsxDeclarations` answers `mx.<target>.defaultTag` first, then `div`; `compilePreactMx` takes `defaultTag`. Shared with React and Hono. Byte-identical for every existing template.

- **Feat (default-tag-core, decision 145):** declares `resolveDefaultTag: () => "div"`, the interim answer for the unnamed tag until the registry ladder lands. Output is byte-identical.

- **Fix (range-loop-name-collision):** a `<for from/to>` mapper's own parameters are named `__mxUnused`/`__mxIndex` instead of `_`/`mxIndex`. Both are in scope for the authored `from`/`to`/`step` expressions written inside the same callback, so an authored `_` or `mxIndex` was shadowed and the loop rendered wrong values silently: `<const/_=5/>` with `<for|i| from=_ to=_+2>` rendered `NaN` three times, and `<const/mxIndex=10/>` with `<for|i| from=mxIndex to=mxIndex+1>` rendered `0, 2`. `until=` alone was never affected (its bound goes into the row count, outside the callback). `__mx` is reserved, so authored code can no longer take either name. Rendered regressions cover Preact, React and Hono. Shared emitter.
- **Fix (reserve-mx-identifiers):** generated dynamic helpers, body/return temporaries and component aliases use `__mx` names. Generated imports alias class, fragment and boundary helpers without changing public exports. Shared with React and Hono; rendered collision regressions cover all three.

- **Fix (attr-value-parity review):** hoist native value/spread guards once per module, including nested definitions and dynamic tags. Reject ordinary function/symbol values with Marko debug text while preserving event handlers and framework props. Shared with React and Hono.

- **Fix (attr-value-parity):** native attributes and dynamic string tags reject unrenderable objects with Marko's render-time error, including final merged spreads. Preserve component props, class/style, controlled writers and framework-only props; authored expressions are evaluated once. Nested `on:`/`style:` fix-its now dispatch on the first prefix instead of suggesting class syntax. Shared with React and Hono.

- **Fix (jsx-text-lt-unescaped):** authored text containing `<` or `>` no longer breaks the generated TSX. `<div>a < b</div>` used to emit the `<` verbatim, and the *generated* `page.mx.tsx` then failed downstream parsing (`[builtin:vite-transform] Unexpected token`). Text children now escape `<`, `>`, `{`, and `}` as numeric character references (`a &#60; b`), which JSX decodes back to the original characters, so rendered DOM text equals Marko 6.3.51's. `&` is deliberately left raw: Marko passes authored entities through verbatim, and JSX decodes `;`-terminated numeric references and the HTML4 named entities the same way a browser does. HTML5-only names (`&check;`) and unterminated legacy forms (`&copy x`, `&lt`) are a known divergence — JSX keeps them literal where a browser decodes them (a full HTML5 entity decoder is tracked separately). Rendered parity tests pin Preact, React, and Hono output. Shared with `@mxlang/react` and `@mxlang/hono`.

- **Fix/test (colon-attr-followups):** ordinary empty-suffix attributes (`x:`) use the existing string-keyed JSX spread instead of losing the colon; shared with React and Hono. A mapping regression pins both the string key and expression value of `value:foo:bar=x` to their authored spans.

- **Fix (scriptlet-hint-let-var):** mutable `$ let`/`$ var` declarations no longer get an immutable `<const>` replacement. This host rejects `<let>`, so its declaration omits keyword advice; `$ const` advice is unchanged. Shared with React and Hono.

- **Fix (jsx-whitespace-body-parity, decision 141):** a same-line whitespace-only body forwarded through `<${input.content}/>` now renders one space, through imports and discovered `tags/*.mx`, rather than disappearing in core. Tabs normalize to one space; newline indentation stays absent. Rendered parity tests cover preact/react/hono; the existing text-body dispatch fix is unchanged.

- **Fix (jsx-intrinsic-prop-errors, decision 140 (b)):** tooling now reports native-element non-event prop type errors (`maxLength="x"`, `foo=1`, `tabIndex="a"`, `class=5`) at the authored attribute name, using the host's own JSX types. Includes boolean props, `key`/`ref`, structured class/style and SVG props; event-prop names, spreads, custom elements and zero-width default-attribute names remain unmapped. Runtime code and Vite source maps are unchanged. Shared with `@mxlang/react` and `@mxlang/hono`.

- **Added (jsx-handler-typing, decision 140):** `CompilePreactOptions.typeCheck`, an internal option for tooling (`@mxlang/typescript-plugin`/`mx-tsc` set it; leave it unset for any build). It emits the module for type checking: every native element's event handler becomes `on…={__mxOn<"tag", "event">(fn)}`, with a generated preamble that finds the host's own handler type by a case-insensitive key lookup on its `JSX.IntrinsicElements` (no hit, such as a custom element, a dynamic tag or an unknown prop, is `any`), and Marko keeps the annotations of shorthand handlers. Runtime output is byte-identical with the option unset. **Effect on users:** in the editor and in `mx-tsc`, a mistyped handler (`<button onClick=((a: string) => a.length)>`, `onClick(a: string, b: string) {…}`) is now an error at the authored handler, the body of a shorthand handler is type-checked, and valid handlers such as `onKeyDown=((e) => e.key)` no longer report an implicit-any error (156 of preact's 193 `on*` names did). Shared with `@mxlang/react` and `@mxlang/hono`.

- **Added (fix-hints-batch, audit item 14):** an unresolved capitalized tag now ends ``Import it (`import Card from "./Card.mx"`) or add `tags/Card.mx`.`` (or ``Did you mean `<Badge>`?`` for a near-miss import), and `(click)="go()"` ends ``; for an event handler write `onClick=go` `` (core). The emitter is shared with `@mxlang/react` and `@mxlang/hono`.

- **Added, unstable (target-registry, decisions 129 and 132):** `./descriptor` subpath exports the `preact-jsx` target descriptor (host `preact`, `preactDeclarations`, `load()` returning `compilePreactMx`). Nothing consumes it yet; see `@mxlang/target-registry`.

- **Added, unstable (target-registry, round 3):** `./emitter` and `./dialect` subpaths export the shared JSX emitter's declarations module and dialect type, so `@mxlang/react` and `@mxlang/hono` can build their dialects without importing this package's compile entry.

- **Fix (dup-attr-last-wins-core, decision 135):** a repeated attribute now emits only the last (the JSX object already kept the last, so behavior is unchanged). The earlier occurrence gets a positioned warning naming the surviving one. See `@mxlang/core`.

- **Breaking (jsx-dialect-rename, decision 132):** the shared JSX emitter's `Target` object is now `JsxDialect`, since "target" now means a registered output format. Renamed, no aliases: `Target` → `JsxDialect`, `preactTarget` → `preactDialect`, `reactTarget` → `reactDialect`, `honoTarget` → `honoDialect`, the `CompilePreactOptions.target` option → `dialect`, and `src/target.ts` → `src/dialect.ts`. No emitted-code change.

- **Breaking (delegated-tag-rename, decision 132):** follows the `@mxlang/core` rename of `claimsTag`/`resolveHostTag`/`HostTag`/`ctx.build.hostTag` to `isDelegatedTag`/`resolveDelegatedTag`/`DelegatedTag`/`ctx.build.delegatedTag`; the host's `Emitter.hostTag` method is now `delegatedTag`. No output or diagnostic change.

- **Fix (jsx-dynamic-body-text):** a text-only body (`<wrap>hello</wrap>`, a sole `${x}`, or a string/number `content`/`children` from a hand-written caller) forwarded through a dynamic tag (`<${input.content}/>`) now renders as text, as in Marko 6.3.51, instead of an element named by the text (`<hello></hello>`). The generated callee preamble turns a string or number body into a fragment (numbers via `String`, so hono keeps a `0`; an empty string becomes `undefined`). `<${tagName}/>` string targets are unchanged. Also covers `@mxlang/react` and `@mxlang/hono`, which share this emitter.

- **Fix (audit-02-for-by-parity):** `<for by=x.id>` (any read of a loop param in `by=`) is now a positioned error, as in Marko 6.3.51, instead of passing silently. See `@mxlang/core`.

- **Fix (audit-01-prop-attr-parity):** an attribute name outside Marko's grammar (`[prop]=`, `#ref`, `*ngIf`) is now a positioned "Invalid attribute name" error, as in Marko 6.3.51, instead of passing through. See `@mxlang/core`.

- **Internal (hook-guard-module-list), round 2:** `HOOK_MODULES` (the closed
  list of hook-import specifiers `rejectHooksInReturningUnit` refuses inside
  a returning unit) moved off a single literal tuple hardcoded in this
  package's `index.ts` and onto `Target.hookModules` — Preact, React and
  Hono each declare their own list on their own `target.ts`, the same
  target-vocabulary pattern `jsxImportSource`/`classAttr`/etc. already use.
  **This narrows the guard for React (`["react"]`) and Hono (`["hono/jsx"]`)
  — each now rejects only the modules it can actually resolve a hook import
  from, since neither has an alias for the other two hosts' modules.**
  Preact keeps a three-item list, `["preact/hooks", "preact/compat",
  "react"]`: `preact/compat`'s whole purpose is making `import { useState }
  from "react"` resolve under Preact, so a Preact-compiled returning unit
  reaching a real hook dispatcher through the `react` specifier is a real
  case, not a hypothetical one — round 1 of this change dropped it, which
  was a real regression (caught in review before merge, no user ever hit
  it). Round 2 restores it and adds a test per host for each specifier it
  declares, including Preact rejecting `"react"` specifically, which had no
  test before and is how the regression slipped through undetected.
- **Internal (source-bindings-silent-parse-failure):** `rejectUnknownTag`'s
  Marko-wording message now comes from `@mxlang/core`'s
  `unresolvedCustomTagMessage` instead of a hand-copied literal. No behavior
  change; shared with `@mxlang/react`/`@mxlang/hono` through the common
  emitter.
- **Fixed:** `mxDynamic` (the shared Preact/React/Hono JSX emitter's
  dynamic-tag helper) now treats a host-recognized component object as a
  component. React's own `memo(Foo)`/`forwardRef(...)` return plain objects
  (`{ $$typeof: Symbol(react.memo), ... }`), not functions, and used to fall
  through `mxDynamic` unrecognized, handing the bare object back as a JSX
  child (React: "Objects are not valid as a React child"). New
  `mxIsHostComponentObject(value)` helper, allowlisted by the marker
  symbol's `description` (`"react.memo"`/`"react.forward_ref"`/
  `"react.lazy"`) rather than merely "carries a `$$typeof` symbol" — every
  React *element* (an ordinary already-rendered node, not just a `memo`/
  `forwardRef` wrapper) also carries one, which misclassified plain rendered
  content as a component. Checked before decision 106's `.content`-guard so
  a recognized object never reaches it. Reachable both as a local
  (`static const Comp = memo(Foo)`) and as a value import. Preact's own
  `memo`/`forwardRef` (real functions, unlike React's) were already
  unaffected; React's raw object form imported directly into a Preact app
  remains unsupported regardless of this fix — measured, Preact's own
  renderer has no object-based component dispatch at all, with or without
  MX. See the spec's decision 116 section for the full detail.

- **Fixed (behavior change, decision 114 parity, `unresolved-tag-jsx-astro-angular`):**
  `<TotallyUndefined/>` — a capitalized tag with no import, binding, or taglib
  entry — now fails to compile with Marko's own error ("Unable to find entry
  point for custom tag `<TotallyUndefined>`."), matching `@mxlang/html` and
  `@mxlang/solid` (decision 114). `isComponent` (`emitter.ts`, shared by
  `@mxlang/react` and `@mxlang/hono`) used to fall back to a bare
  `isComponentName` (`/^[A-Z]/`) casing test whenever the taglib lookup found
  nothing, so an unresolved capitalized tag silently emitted a JSX component
  reference to nothing — a runtime `ReferenceError`, not a compile error. The
  fallback is now `false`, and `rejectUnknownTag` reports Marko's wording
  through the existing `lower.ts` hook. A type-only import already did not
  resolve a tag (decision 114/115); unaffected by this change. A decision-116
  dynamic-tag-routed value import (below) is a distinct, in-scope binding and
  is unaffected — its `valueImportBinding` reaches `isComponent` through
  `ctx.imports` the same as any other import.
- **fix (decision 116):** a value import that is not a `.marko`/`.mx` default
  import now lowers through `mxDynamic` instead of a direct call — matching
  Marko's own `_dynamic_tag` dispatch for a string, `undefined`, `null`, or a
  plain object; an intentional divergence for a plain function, still called
  and its return kept, since an imported `.tsx` component (or an MX
  component on html) IS a plain function. Two host-side fixes needed for
  this to reach parity: `#propsObject`'s `owner` was unconditionally
  `undefined` for a `kind: "dynamic"` target, silently dropping typed
  attribute-tag checking for every such call — it now reads the target's
  `valueImportBinding` (core's new provenance field) the same way a
  `kind: "name"` target's own binding name is used. `mxDynamic`'s own
  parameters were implicitly `any` under `strict` TypeScript, which surfaced
  only once decision 116 started routing real imports through it far more
  often; both are now explicitly typed. `@mxlang/react` shares this through
  the common emitter.
- **fix:** a dynamic tag or `<define>` call now accepts arguments plus content
  (decision 109). `mxDynamic`'s payload array carries a trailing props object
  after the arguments when there is content or an attribute tag to forward,
  matching Marko's shape (unchanged runtime, since it already spread the
  whole payload into the call). A `<define>` call combines the tag-argument
  form with a body or attribute tags by extending its existing positional
  named-lookup scheme: params beyond the consumed args are filled from the
  same named lookup used for the no-args call shape. Arguments plus a plain
  attribute are still rejected. `@mxlang/react` and `@mxlang/hono` share this
  fix through the common emitter.
- **fix (behavior change, decision 112):** a **string-target** dynamic tag
  called with arguments now uses `args[0]` as its input (attributes),
  matching Marko's own `_dynamic_tag`. Previously `mxDynamic` rendered a bare
  `<Tag />` for a string target with arguments, ignoring them entirely. A
  null/undefined `args[0]` is treated as `{}`; extra arguments beyond
  `args[0]` are ignored; decision 109's trailing props object is appended
  *after* the positional args, so it is never `args[0]` and its
  attribute-tag values are not read as input — `mxDynamic` gained a third
  `content` parameter so content still renders regardless, matching Marko's
  independent content channel. `@mxlang/react` and `@mxlang/hono` share this
  fix through the common emitter and runtime helper.
- **breaking:** attribute tags now follow the callee-declared decision-106
  shape. Data tags receive `{ ...attrs, ...nestedProps, content }`, renderable
  tags receive the body, arrays are real arrays, and conditional/loop tag
  expressions are evaluated during the caller's render. The package now
  exports Preact-specialised `AttrTag<C>`.
- **breaking:** decision 108 passes an untyped body-only attribute-tag prop as
  a bare renderable. Any attributed or nested occurrence keeps that fallback
  property data-shaped; declared shapes and cardinality are unchanged.
