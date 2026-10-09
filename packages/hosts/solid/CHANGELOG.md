# Changelog

- **Fix (dynamic-tag-var-silent-drop, core):** a tag variable a host cannot bind (`/n` on a dynamic tag — Solid does not set `bindsDynamicTagVar`) is reported at the `/var` itself, not at the whole tag: `<div>\n  <${C}/n/>\n</div>` fails at line 2, column 8 (the `/n`), where the refusal used to sit at the tag. Message and outcome unchanged (the refusal stands); position only.

- **Fix (routed-template-call-namespan):** a discovered tag's call maps its name span, so a type error on it (a missing required prop) lands on the tag name, not at 1:1 marked MX's. No emitted code changes, only the source map.

- **Fix (solid-method-shorthand, decision 167):** an attribute method is emitted as written: a method shorthand (`onClick() { … }`) as the `function` expression the compiler printed for it (`function (e) { … }`, `async function () { … }`, `function <T>(e: T) { … }`), and an authored `function` expression or arrow unchanged. The method used to be turned into an arrow by a regex that split at the last `) {`, so `onClick() { if (c) { go() } }` compiled to `() { if (c) => { go(); } }`, which is not JavaScript. A named function lost its binding as an arrow, and a generic method was invalid TSX. The method's body is now mapped token by token against the authored body (`Expr.bodySpan`/`bodySource`), so a TypeScript error inside it, async, generic or nested, reports at its authored column; its printed head stays unmapped. A `<for in>` comma-expression source is parenthesized, so it stays one argument to `Object.entries`. The oracle's `counter` twin (dom) records the function-vs-arrow form as a divergence.

- **Fix (native-tag-binding-capture, decision 164):** a module-scope import named like a native element no longer turns that element into `<Dynamic>`; it stays native. A warning is raised at the tag (without the binding's position).
- **Added (bridge-host, decision 154):** `appendSolidBuiltinImport` (moved from `@mxlang/typescript-plugin`) is Solid's `completeTypecheckModule` on the `.solid.mx` file kind, behind the descriptor's lazy `require`; also exported. Output unchanged.

- **Changed (solid-rename, decision 154):** the Solid file kind's `languageIds` are now `["solidmx", "solid"]` (was `["solidmx", "SolidMX"]`): Zed derives its LSP language id from the lowercased language name, and its language is now `Solid`. The `solidmx` id, `compileSolidMx` and the `.solid.mx` suffix are unchanged.

- **Fix (jsx-textarea-value-content, decision 149):** `<textarea value=x/>` renders the value as escaped content, as Marko 6.3.51 does: `null`/`undefined`/`false`/`true` render nothing, `0` and `""` are kept, a leading newline is doubled for the server, a later `value` beats an earlier spread's, and a spread's `value` yields to a body. An explicit `value` together with body content is the compile error "A textarea cannot have both a value attribute and body content." A runtime-resolved `<${tag} value=…/>` that is a textarea takes `value` as content and rejects `content`. Solid doubles under `isServer`, for a runtime-resolved `<${tag} value=…/>` (a `value` attribute, a spread or the args object) too, through `__mxTextareaDynValue`/`__mxTextareaDynSpread`, which leave every non-textarea target and the client render untouched. A runtime-resolved `<${tag} value=…>body</>` whose tag is `textarea` throws Marko's dynamic-textarea content error.

- **Fix (solid-astro-angular-primitive-attr-parity, decision 149):** a dynamic native `class` and the `class`/`style` keys of a native spread now render as Marko does (falsy primitive omitted, `true` printed as `"true"`) instead of Solid's always-present `class=""`: `class=expr` lowers to a `__mxClassProp(...)` prop spread and `__mxAttrSpread` filters falsy `class`/`style` keys. `<input checked=expr>` without a spread is presence only (`0`, `"x"` set it). Component props, static attributes and object/array `class` are unchanged. A direct `style=expr` non-object stays a compile error.

- **Fix (solid-stepped-range-not-reactive, decision 149):** a stepped `<for from= to=|until= step=>` now follows its reactive bounds like an unstepped range. The row value was a `const` inside the `<Repeat>` callback, which Solid never re-runs, so `from=base() to=base()+4 step=2` kept rendering `10, 12, 14` after `setBase(20)`. `from` and `step` are evaluated once per (re)render of the loop (Marko 6.3.51 evaluates its `_for_to(to, from, step, …)` head once), bound to constants in an IIFE around the `<Repeat>` unless both are literals; reads of the row param expand to `(__mxFrom) + __mxIndex * (__mxStep)`, so every read in one row agrees even for an impure bound, and `to`/`until` still follow signals through the count prop. A change to a non-literal `from` or `step` recreates the stepped rows (aligned with the unstepped range, which also rebuilds when `from` changes), while a change to `to`/`until` grows or shrinks them in place. A write to a stepped row value now fails with a stepped-specific message. Executed jsdom regressions for each bound; SSR output and unstepped ranges are unchanged.

- **Test (html-imported-return-tag-object-object):** `imported-return-render.test.ts` renders an imported `.mx` tag that declares `<return>`, called without `/var`, through Solid SSR. No emitter change: Solid hands the value back through a callback prop, so the markup already rendered.

- **Fix (solid-object-attr-value-silent, decision 149):** a plain-object (or null-prototype, function, symbol) value on a dynamic native attribute now throws Marko's `The `data-x` attribute cannot be a plain object (it would render as `[object Object]`).` at render, on SSR and DOM output. Unknown-typed dynamic attributes compile to `__mxAttrValue(...)` and native-element spreads to a lazy validating Proxy (`__mxAttrSpread`); string-valued, class/style/ref/children, `on:`/`use:`/`prop:`/`attr:`/`bool:` and component attributes compile as before. `innerHTML`, `textContent`, `classList`, `:foo` and string-target dynamic tags are validated too. Oracle rows `attrs` and `todos` are recorded divergences.

- **Fix (jsx-text-entities, round 2; supersedes the earlier parity claim below):** browser-only decoding is correct for intrinsic-element templates, **not** for component/control-flow text. Such bodies now HTML5-decode with `entities@6.0.1` (including surrogate references → U+FFFD) and use a lazy build-conditioned escape: escaped HTML in SSR, decoded text nodes in the DOM build. `<if>`/`<else>`, `<for>`, fragments, component children and `<try>` no longer turn authored `&lt;b&gt;` into live markup or double-decode `&amp;copy;`. Real `renderToString` and jsdom DOM tests check text and element structure against live Marko/parse5 evidence. Intrinsic templates and attributes retain their existing behavior.

- **Fix (marko-parity-trio, `:modifier`):** `<div :foo="y"/>` compiles to `value:foo={y}`, which both Solid 2 backends lower to `setAttribute(el, "value:foo", …)`; MX previously rejected the form as a malformed namespaced attribute.

- **Fix (jsx-text-entities):** verified at parity, no decode change. Solid's pipeline already applies Marko's own model to authored `&…`: `@solidjs/babel-plugin` passes JSX text through unaltered, and the SSR string (or the DOM template, which the browser parses with full HTML5 rules) carries the authored spelling to the browser, so legacy no-semicolon names (`&copy 2026`), HTML5-only names (`&check;`), unterminated numeric references (`&#123`), and surrogate references all render exactly as Marko 6.3.51's browser parse — unlike the Preact/React/Hono JSX transforms, which decode only `;`-terminated numeric references and the HTML4 named set and now compensate in the emitter. Probed case-by-case against Marko + parse5; the emitter comment now documents the deliberate passthrough (the stale TODO is removed).

- **Fix (preact-html-comment-literal-element):** `<html-comment>` is now a positioned compile error — `an HTML comment (<html-comment>) cannot appear in a Solid component: JSX has no comment node…` — instead of silently emitting a literal `<html-comment>` element where Marko renders `<!--…-->`.

## Unreleased

- **Fix, behaviour change (unresolved-tags-dir-diagnostic, decision 172):** a `.marko` file used as a tag, and a `tags/x/index.mx` directory tag, are one positioned error at the tag naming the file (core's check), not a silent native `<x>`.

- **Fix, behaviour change (define-call-attrs-solid, decision 160):** a `<define>` called with attributes and no tag arguments passes ONE object to its first param, as Marko 6.3.51 does: `<Row n=1/>` against `<define/Row|p|>` or `|{ n }|` hands `Row` `{ n: 1 }` (spreads, attribute tags and `content` included; `{}` when the call carries none). It used to emit `__mx_DefineRow1(undefined)`, and a destructured param (`|{ n }|`, `|{ n }, i|`) failed compile with "cannot close over `n`" because the capture check read the pattern's source text as a name; it now binds the names the pattern introduces. **Behaviour change:** the per-param lookup (`<define/Card|title, head|>` + `<Card title="a"/>` binding `title` to `"a"`) is withdrawn on Solid; such a call now gets one object in `title`, and core warns at the call (`defineCallPassesAttrs` is set) to destructure it (`|{ title, head }|`). A call with tag arguments is unchanged, and a spread is accepted on the object path.

- **Fix, behaviour change (statement-followup, decision 168):** JSX in a `static`/`export`/`server` statement (`static const el = <b>hi</b>` followed by a template line) was a silent swallow of the next template line on Solid (the statement ran on into it, leaving an empty template); it is now a positioned error at the `<` naming JSX in a statement. A decorated `static class` is accepted again.

- **Fix, behaviour change (statement-tags, decision 168):** `client` and `server` statements are positioned errors (they were emitted as `<client>`/`<server>` elements with the statement text as attributes); `class { … }` is a positioned not-supported error. Typed statements parse as statements.

- **Fix:** the `For` emission copies the node instead of appending to `For.bindings` and rewriting `code` in the shared IR; output unchanged.


- **Fix (default-tag-contracts r2):** the parent contract's `defaultTag` is seen through `if`/`for`/`try`; an invalid value falls through.

- **Added (default-tag-contracts, decision 145):** the parent contract's `defaultTag` is the first rung for the unnamed tag, in the page compile and `.solid.mx` regions.

- **Added (default-tag-ladder, decision 145):** the descriptor declares `defaultTag` (`DEFAULT_TAG`, `div`); `solidDeclarations` answers `mx.solid-jsx.defaultTag` first, then `div`, for the page compile, `compileSolidUnit` and each `.solid.mx` region (`HostRegionInput.defaultTag`).

- **Feat (default-tag-core, decision 145):** declares `resolveDefaultTag: () => "div"`, the interim answer for the unnamed tag until the registry ladder lands. Output is byte-identical.

- **Fix (range-loop-name-collision):** a `<for step=...>` mapper's counter is named `__mxIndex` instead of `mxIndex`. The row value is derived from the index *inside* Solid's `<Repeat>` callback, so the counter shadowed an authored binding of the same name: `<for|i| from=mxIndex to=mxIndex+4 step=2>` rendered `0, 3, 6` where the author wrote `10, 12, 14`. An unstepped range is unaffected (`from=`/`count=` are evaluated outside the callback) and is pinned as such. The whole-unit wrapper's `$mxProps`/`$mxBody`/`$mxValue`, the `$mxChildren`/`$mxMerge` imports and the hoisted `$mx_Define*` bindings become `__mx`-reserved too; `$mx_Define*` had a reachable silent duplicate declaration against an authored module-scope function of the same name. The `$mxReturn` property protocol is unchanged. Executed SSR and DOM regressions. The `lists` oracle twin and its goldens are regenerated for the rename.
- **Fix (reserve-mx-identifiers):** private escape, escaped-block and dynamic-tag temporaries and `/var` callback parameters use reserved `__mx` names. The `$mxReturn` property protocol is unchanged. Real SSR regressions pin authored bindings with the former private names.

- **Fix (jsx-text-lt-unescaped):** authored text containing `<` or `>` no longer breaks the generated JSX a `.solid.mx` region splices into the surrounding TypeScript. Text children now escape `<`, `>`, `{`, and `}` as numeric character references, which JSX decodes back to the original characters, so rendered text equals Marko 6.3.51's; authored entities decode the same as in a browser only for `;`-terminated numeric references and the HTML4 named set — HTML5-only names and unterminated legacy forms stay literal (known divergence, tracked separately). Pinned by executed Solid SSR output.

- **Fix/test (colon-attr-followups):** ordinary empty-suffix attributes (`x:`) use the existing string-keyed JSX spread instead of losing the colon, pinned through a real DOM render. A mapping regression pins both the string key and expression value of `value:foo:bar=x` to their authored spans.

- **Fix (scriptlet-hint-let-var):** the surrounding-TypeScript-module advice preserves the original `let`/`var` keyword, instead of changing a mutable scriptlet to `const`. Solid still rejects `<let>`; `$ const` advice is unchanged.

- **Fix (jsx-whitespace-body-parity, decision 141):** the body channel now receives same-line whitespace-only content from imported components and discovered `tags/*.mx`, rendering one space rather than nothing. Core retains Marko-normalized text; newline indentation stays absent. Pinned by executed Solid SSR output.

- **Fix (solid-raw-body-tag-params-unbound):** a raw `$!{}` as the sole body of a component or dynamic tag with params (`<Row|item|>$!{item}</Row>`, `<${x}|item|>$!{item}</>`) was hoisted onto `innerHTML={item}` with the params unbound, so it compiled and threw `ReferenceError: item is not defined` at render. It is now a positioned compile error at the `$!{` saying why: Solid has no wrapper-free raw-HTML form; wrap it, e.g. `<div innerHTML=item/>`. A `<define>` call, `<for>`, `<if>` and attribute-tag body were already refused, but with the misleading "raw placeholder must be the only child"; they now get the same accurate message. Marko renders the raw HTML in the callback; recorded in `divergences.md`.

- **Fix (fix-hints-batch round 2):** the scriptlet hint now says to declare the value in the surrounding TypeScript module (`const y = …;`), since a `.solid.mx` region rejects `<const>`; it is declared through the new optional `scriptletReplacement` host declaration.

- **Added (fix-hints-batch, audit item 14):** an unresolved capitalized tag now ends ``Import it (`import Card from "./Card.mx"`) or add `tags/Card.mx`.`` (or ``Did you mean `<Badge>`?`` for a near-miss import), `(click)="go()"` ends ``; for an event handler write `onClick=go` ``, and a `$` scriptlet ends ``; declare a value with `<const/x=…/>` ``.

- **Fix (solid-params-body-sole-component):** a tag-params body whose sole child rendered as a bare expression (`<for|item| of=input.items><Badge label=item/></for>`, a sole `${}`-dispatched dynamic tag, a render-prop or `<@catch>` body) was emitted as `(item) => {(() => { … })()}`. An arrow followed by `{` has a block body, so the callback returned `undefined` and the list rendered nothing while the output still compiled. The body is now wrapped in the `<>…</>` fragment the multi-child path already uses (every body already starting as JSX is byte-identical). Covers `<for of>`, `<for in>`, `<for to>` (plain and stepped), render-prop tag bodies, attribute-tag renderables, and the `<try>` fallback. Round 2: the same wrapper (`jsxValue`) now also covers the `<try>` `<@placeholder>` `fallback={…}` value and a `<define>` call's no-params body argument, where a `{`-led body was a syntax error (`fallback={{…}}`, `{$mx_DefineR1({$mx_DefineA1(1)})}`). preact/react/hono were checked and are unaffected. Pinned by executed SSR tests in `src/arrow-body.test.ts`.

- **Added, unstable (target-registry, decisions 129 and 132):** `./descriptor` subpath exports the `solid-jsx` target descriptor (host `solid`, `mappings: "merge-recorded"`, file kind `solid` with its language ids, `compileRegion` and `readCalleeInput`). The `.solid.mx` callee reader moved, unchanged, from `src/index.ts` into `src/callee-reader.ts` so the descriptor can reach it lazily; `index.ts` still registers it on import. No behavior change. Nothing consumes it yet; see `@mxlang/target-registry`.

- **Cleanup (dup-attr-last-wins-core round 2):** removed the `#id`-with-`id=` and repeated-`class` guards in `renderAttrs`, unreachable now that core resolves duplicates; no behavior change.

- **Fix (dup-attr-last-wins-core, decision 135):** a repeated attribute now emits only the last. One visible change: Solid used to fold a static `class="x"` and a later `class={c: on()}` into one array (`.card` shorthand included); core now keeps only the later one, as Marko does (`<div.card class="x" class={c: on()}>` is `_attr_class({c: on()})`), with a warning. The earlier occurrence gets a positioned warning naming the surviving one. See `@mxlang/core`.

- **Breaking (delegated-tag-rename, decision 132):** follows the `@mxlang/core` rename of `claimsTag`/`resolveHostTag`/`HostTag`/`ctx.build.hostTag` to `isDelegatedTag`/`resolveDelegatedTag`/`DelegatedTag`/`ctx.build.delegatedTag`; the host's `Emitter.hostTag` method is now `delegatedTag`. No output or diagnostic change.

- **Fix (solid-body-content-channel):** `<${input.content}/>` rendered nothing on Solid for every body, element and text alike. A Solid component receives its body as `props.children` and nothing populated `input.content`, Marko's body channel, so `<Card><p/></Card>` compiled cleanly and rendered an empty card. A unit that reads `input.content` now gets `input` as a lazy `merge` view over its props whose `content` is the body (an explicit `content=` prop wins, else `children`), resolved once through `children()` so a body read twice is not created twice and a reactive body keeps updating. Additive: `props.children` is untouched, so a hand-written Solid component called from MX and an MX tag called from plain TSX both work, and a unit that never reads the body is emitted exactly as before. A bare string or number body becomes a fragment (an empty string becomes `undefined`) so a forwarded text body renders as text, not as a tag name, aligned with the preact/react/hono callee preamble (#212). When `<if=input.content>` is a unit's only use of the body, the body is still evaluated once (inherent to the `children()` memo), and a present-but-empty body takes the else branch (recorded in `divergences.md`). Pinned by executed SSR and client tests in `src/body-content.test.ts`.

- **Fix (audit-02-for-by-parity):** `<for by=x.id>` (any read of a loop param in `by=`) is now a positioned error, as in Marko 6.3.51, instead of passing silently (solid used to surface a stray `TS2304` at a generated position). See `@mxlang/core`.

- **Fix (audit-01-prop-attr-parity):** an attribute name outside Marko's grammar (`[prop]=`, `#ref`, `*ngIf`) is now a positioned "Invalid attribute name" error, as in Marko 6.3.51, instead of passing through. See `@mxlang/core`.

### Test: a real client (DOM) render harness for live `<for>` updates (solid-client-render-harness)

New `src/client-render.test.ts`: every prior render test in this package (`ssr-render.test.ts`) proves the emitted `<For>`/`<Repeat>` binding renders the right shape once, server-side, through Solid's SSR codegen — none of them mount a component and mutate a live signal. This file compiles the same MX `<for>` fragments through Solid's *client* (DOM) codegen instead, mounts them into a real `jsdom` document (a Bun subprocess, `--conditions=browser` forced — `@solidjs/web`'s package exports branch on a `worker`/`browser`/`deno`/`node` condition key and Bun's default `node` condition otherwise silently resolves the SSR build), writes a same-key row replacement to the backing signal, and asserts the live DOM re-renders — including that a surviving row keeps its own DOM node identity (a stamped `data-mx-node-id`, since a real DOM node cannot cross the subprocess boundary) and reacts live to a further value-only change on that same row — across all four `<for>` keying modes (`by="id"`, `by=(fn)`, unkeyed `of=`, and `in=`). New devDependency: `jsdom@30.1.1` (exact-pinned; bumps the transitive `vitest` peer's own optional `jsdom` from 28.1.0 to 30.1.1, otherwise unaffected). `happy-dom` was tried first and rejected: it throws inside `@solidjs/web`'s own `insertExpression` on the very first client render of a template with a reactive text child (a real incompatibility with Solid 2's DOM codegen, not a config gap) — measured directly, not assumed. Confirmed regression-detecting by locally reverting `@mxlang/core`'s `rewriteAccessorReads` (rebuilding core's `dist/` to pick up the change — a stale `dist/` fails this silently, see this package's own CLAUDE.md) and observing three of the four tests crash inside `@solidjs/signals`, then restoring it.

### Fix: a whole-file unit's `/var` declares `let n: any;`, not a bare `let n;` (tag-var-type-from-return)

Firstmate's ruling (2026-09-28), filed from PR #159 round 2, option C: the value bound from a `<return>` unit's `$mxReturn={...}` callback prop cannot be typed as the `<return>` expression's real type without changing the emitted runtime JS — TypeScript's `typeof` only accepts an identifier, never an arbitrary expression, and the expression can depend on the unit's own body locals, so no type-only declaration beside the component can name it either. `compileSolidUnit` now declares the binding `let n: any;` explicitly instead of a bare `let n;`, which additionally reported `noImplicitAny`'s own TS7005 at every read — unrelated noise, now silenced. The bound value's type is still `any`, a known Solid-only limitation (documented in the spec's `/var` section and this package's AGENTS.md), unlike html/preact/react/hono, which already infer the real type through a `const n = temp.value;` binding. Pinned by a regression test naming the limitation, so a future fix (MX 2's per-callback-scope statement position) flips the assertion.

### Feat: `compileSolidUnit` types a whole-file component's props (solid-whole-file-prop-typing)

`compileSolidUnit` now emits the author's `export interface Input` and annotates the component parameter (`export default function Card(input: Input)`), the same shape as `@mxlang/html` and `@mxlang/preact`, so a caller's `<Card title=1/>` against `title: string` is TS2322 through the TypeScript plugin, `mx-tsc` and the editor. A unit with no `Input` gets `export interface Input {}`; a unit declaring `<return>` widens the parameter with the `$mxReturn` callback prop; an `AttrTag` in `Input` gets `import type { AttrTag } from "@mxlang/solid"`. **The output is now TSX carrying types, so it needs a TypeScript-aware step**: the vite path already has one (`@mxlang/vite-plugin` gives whole-file units a `.tsx` id, `@solidjs/compiler` parses TypeScript and passes the types through, vite strips them). The old "Solid's compiler has no TypeScript frontend" premise was wrong. The custom-tags oracle harness now loads compiled Solid units as `.tsx`.

### Internal

- `rejectUnknownTag`'s Marko-wording message (`source-bindings-silent-parse-failure`)
  now comes from `@mxlang/core`'s `unresolvedCustomTagMessage` instead of a
  hand-copied literal. No behavior change. Confirmed separately: a
  module-level syntax error in the surrounding `.solid.mx` module (next to
  a genuinely imported component) already surfaces as the real syntax
  error through the real `parse()` pipeline (`collectModuleScope`'s own
  uncaught `babelParse`), never the misleading "Unable to find entry point"
  fallback — pinned by a new test in `@mxlang/parser`'s `mx.test.ts`.

### Fixed

- A non-import module-scope local used as a tag whose value is not statically
  a function/arrow/class now lowers as a dynamic tag too (local extension of
  decision 116, firstmate's ruling). `CompileSolidMxOptions` gained
  `unknownModuleBindings?: ReadonlySet<string>`, folded into
  `ctx.unknownLocalValue` alongside the existing `moduleBindings` fold; a
  plain `function Foo(){}`/arrow-valued `const` keeps its pre-existing direct
  JSX call, unchanged. A `<const>` region binding is classified the same way
  from its own value expression, and a `<for>`/`<define>` tag param is always
  classified unknown, since its runtime value can never be inspected at
  lowering time.

- A value import that is not a `.marko`/`.mx` default import now lowers as a
  dynamic tag (decision 116), matching Marko's own `_dynamic_tag` runtime
  dispatch — a string renders as an element, `undefined`/`null` render only
  the tag's body content (previously the dynamic-tag guard discarded the
  body outright for any falsy target — Marko renders it), and a plain
  function is still called as a host component (an intentional divergence:
  an imported `.tsx` component IS a plain function). Typed attribute-tag
  checking on such a call still resolves the real callee's `Input` through
  the target's new `valueImportBinding`, exactly as a direct call does.
  `@mxlang/parser`'s module-scope scan (`collectModuleScope`) now also
  tracks which import bindings are `.marko`/`.mx` defaults
  (`mxImportDefaultFromMarkoOrMx`, threaded through `MxRegionCompile`) so a
  real `.solid.mx` region resolves the same way a unit test does. A region
  whose entire content is one dynamic tag used to fail to re-parse
  ("Unexpected token") because the compiled JSX child-expression-container
  braces (`{(() => {...})()}`) are not a standalone expression on their
  own; the bridge now retries the parse with those braces stripped when the
  first attempt fails.
- A type-only import (`import type Widget from "./widget.mx"`, or
  `import { type Widget } from "..."`) no longer resolves `<Widget/>` as a
  component: it now reaches Marko's own unresolved-tag compile error, on
  every whole-file `.mx` entry point (`compileSolidUnit`) as well as every
  other host, since the fix is in `@mxlang/core`'s shared import-binding
  resolution (decision 114/115). A type-only import is still emitted
  verbatim.
- `<define>` is supported inside a `.solid.mx` region (decision 110b).
  Previously a compile error: `` `<define>` cannot declare a function
  inside a JSX expression; declare it in the surrounding TypeScript module
  ``, on every `<define>` written inside a `.solid.mx` region,
  unconditionally.

  A top-level `<define>` inside a region now hoists to a gensym'd
  module-scope function, the same way `compileSolidMx` already hoists a
  discovered tag's synthesized import — `CompileSolidMxResult` gained a
  matching `hoistedDefines` field, and `@mxlang/parser`'s bridge writes both
  into the surrounding module. After hoisting, decision 109's `<define>`
  call shapes (no arguments, arguments, attribute tags, arguments plus
  content and attribute tags) apply on Solid too, through a plain
  function-call expression at the call site (`{$mx_DefineRowN(...)}`)
  rather than a JSX tag — JSX has no positional-call syntax, so this
  differs from every other `Component` target on this host, which prints
  an ordinary `<Tag .../>` element.

  Two constructs a hoisted `<define>` cannot express, both reported as a
  positioned error rather than silently wrong code:

  - **Nested inside `<if>`/`<for>`/an attribute tag/another `<define>`.**
    Only a direct top-level child of the region hoists; module scope has no
    per-row or per-branch scope for a nested one to close over.
  - **Closing over a value local to the region** — a binding from the
    surrounding TypeScript function the region lives in (a signal from
    `createSignal`, a prop). A hoisted `<define>` becomes a real
    module-scope function and can only reference its own params, another
    top-level `<define>`'s name, and the module's own imports.

  See `packages/hosts/solid/AGENTS.md` and
  `apps/docs/docs/specification.md` §5.4 for the full contract, and the new
  `fixtures/define-hoist` oracle fixture (recorded as a documented
  `divergences.md` entry: MX's gensym'd function names can never byte-match
  a hand-written twin's natural names, verified semantically identical
  otherwise).

- An unresolved capitalized tag is now a compile error, matching Marko
  (decision 114). `isComponent` (`emitter.ts`) was a bare `/^[A-Z]/` test
  with no resolvability check — any unresolvable capitalized tag
  (`<TotallyUndefined/>`, or a self-recursive `<define>` before its own
  name is registered) silently lowered as an ordinary component call and
  printed a bare JSX reference to a binding nothing declares, a runtime
  `ReferenceError` rather than a positioned MX error. It now returns `true`
  only when the name genuinely resolves: through the surrounding
  TypeScript module's own top-level value bindings (an import or a
  top-level `const`/`function`/`class`, type-only bindings excluded), or
  one of Solid's own JSX built-ins (`Show`, `For`, `Switch`, `Match`,
  `Repeat`, `Errored`, `Loading`, `Dynamic`). Everything else reaches
  Marko's own positioned error (`` Unable to find entry point for custom
  tag `<Name>`. ``, verified against `@marko/compiler` 5.42.5 /
  `marko@6.3.51`) through a new `rejectUnknownTag` declaration.

  **Behavior change**: a `.solid.mx` template (or whole-file `.mx`
  resolved to the Solid host) that previously compiled to a dangling JSX
  reference for an unresolvable capitalized tag now fails to compile
  instead, naming the tag. A whole-file `.mx` compiled to Solid still
  cannot use an authored `import` for such a name (a separate,
  pre-existing limitation — `compileSolidMx` rejects any module-level
  statement outside a real `.solid.mx` region); a registered custom tag is
  the resolution route available there.

### Breaking

- Attribute tags now follow the callee-declared `AttrTag` cardinality and
  shape. Solid renderables are reusable accessors: `() => JSX`, or
  `(...params) => () => JSX` for parameterized tags. Data-shaped tags carry
  that accessor under `content`; arrays, control flow, attributes and nested
  tags are preserved.

### Added

- `compileSolidUnit` now returns the same full result shape as
  `compileSolidMx`: `map`, `mappings`, `dependencies` and a `warnings` sink
  option, driven by the same `emitSolidWithMappings` mapping story (decision
  115). Previously it returned only `{ code }`, which was enough to compile
  a whole-file `.mx` to a Solid component but left every consumer needing
  correct diagnostic positions or dependency-based HMR invalidation with
  nothing to read. `hoistedImports`, `hoistedDefines` and `returnVars` are
  always empty here — those exist only for a `.solid.mx` *region*, spliced
  into someone else's module; a tag unit is a whole file with its own
  module scope.
- Export `AttrTag<C>`, specialised to Solid's accessor renderable.
- Resolve imported callees inside `.solid.mx` regions and report their files
  as compile dependencies for Vite invalidation.
- Escape root interpolations in reusable renderables and lazy control-flow
  bodies during SSR without sacrificing client reactivity.
- Diagnose parameterized attribute-tag values rendered without arguments and
  data-shaped values rendered without their `.content` accessor.

- **Changed (solid-use-core-mappedmethod):** - solid: method shorthand attributes (`onClick() { … }`) now map through `@mxlang/core`'s `mappedMethod` instead of a local copy of the same helper. Emitted code and source maps are unchanged.
