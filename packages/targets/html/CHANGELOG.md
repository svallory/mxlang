# @mxlang/html

- **Feature (render-sink, decision 155):** a compiled unit has a sink entry, `render(input, out)`, which writes its HTML to `out` and returns its `<return>` value. It is the module's named `render` export and is also reachable as `Name.render` on the default export. The default export keeps its signature, `(input) => string`. Calls between tags pass the caller's sink down, and `/var` binds `render`'s return value. A callee the compiler cannot see (a dynamic tag, a `.ts` barrel re-export, a hand-written function) is dispatched at run time: it is rendered through `.render` when it has one, and otherwise called with its string written. A new `@mxlang/html/runtime` export holds `createOut()`, `createBufferedOut(parent)` and the `Out`/`BufferedOut` types, which the main entry re-exports. The ambient `*.mx` typing declares `render`. Emitted code now writes with `__mxOut.write(…)` instead of `__mxOut += …`, and every compiled module imports `createOut` at run time.
- **Fix (dynamic-tag-return-unit-object-object):** a `.mx` unit that declares `<return>` renders its body when it is reached through a dynamic tag (`<${Counter}/>`) or a `.ts` barrel re-export. It rendered `[object Object]`.
- **Fix (dynamic-tag-var-silent-drop):** `/var` on a dynamic tag (`<${Counter}/n/>`) binds the callee's return value, as in Marko 6.3.51. It was silently dropped. The binding is `undefined` for a callee without `render`.
- **Behaviour fix (render-sink, Marko parity):** a `<try>` body renders into a buffered sub-sink. When the body throws, its partial output is now dropped and `<@catch>` renders in its place, which is what Marko 6.3.51 renders (`<div>caught</div>`, not `<div><b>before</b>caught</div>`). Rendered output changes for such templates.
- **Behaviour fix (render-sink, Marko parity):** a `<try>` without `<@catch>` rethrows, as Marko 6.3.51 does. It used to swallow the error (`catch {}`) and render nothing for the body. A template relying on the silent swallow now throws.
- **Fix (render-sink):** `/var` on a dynamic tag called with arguments (`<${Counter}/n({ start: 2 })/>`) renders through the callee's `render` with args[0] as its input, and binds the return value, as in Marko 6.3.51.
- How these are locked against Marko: the `try-catch-partial`, `try-nested` and `try-child-throw` oracle fixtures lock the partial-output drop, and `dynamic-tag-var` locks `/var` on a dynamic tag, with and without arguments. The catch-less rethrow is locked by a unit test against measured Marko 6.3.51 output; the oracle cannot express a throw, and `try-no-catch` covers only the path that does not throw.

- **Changed (bridge-host, decision 154):** the Bun loader's filter is built from its lookup: it declines every host module file kind the lookup registers plus Solid's and Astro's (`mxFilter`, exported for tests); with the package's own lookup it is the same filter as before.

- **Fix (html-comment-escape-falsy, decision 149):** a `<html-comment>` placeholder that is `false`, `null`, `undefined` or `""` renders nothing (it rendered the text `false`), `0` is kept, `true` renders `true`, and a comment with placeholders and no static text that all render empty is `<!-- -->` (Marko's `|| " "` fallback). `$!{}` leaves `>` unescaped, as Marko's `_unescaped` does. Locked by the `html-comment-falsy` oracle fixture.

- **Fix (html-imported-return-tag-object-object):** an imported `.mx` tag that declares `<return>`, called without `/var`, renders its body and drops the value (`<div><span>1</span></div>`) instead of `[object Object]`, as Marko 6.3.51 does. The fix is in `@mxlang/core` (the call now carries `returnsValue`); the html emitter's existing unwrap does the rest.

- **Fix (html-textarea-value-content, decision 149):** `<textarea value=x/>` renders the value as escaped content (`<textarea>0</textarea>`), as Marko 6.3.51 does, instead of a `value` attribute. `null`/`undefined`/`false`/`true` render nothing, `0` and `""` are kept, a leading newline is doubled, a spread's `value` is content (a body wins over it), a dynamic `<${"textarea"} value=…/>` does the same, and an explicit `value` together with a body is Marko's compile error. Known divergence: a `null`/`undefined` spread on a textarea throws in Marko; here it is ignored and renders empty, as the target documents for every tag.

- **Fix (marko-parity-trio, `:modifier`):** `<div :foo="y"/>` compiles and renders as `<div value:foo="y">`, Marko's own attribute (MX previously rejected it).

## 0.1.0 (unreleased)

- **Changed (name-sugar-default-value, decision 146 addendum 4):** `<input #x=1/>` renders `id="x"` plus `value="1"` (a sugar followed by `=value` sets the default attribute); a method value needs a runtime, as before; a second default value is a positioned error.

- **Docs (name-sugar-tooling, decision 151 ruling 4):** the README warns that `prettier-plugin-marko` bundles a stock htmljs-parser and rewrites `<a x=a .b/>` to `<a x=a.b/>`; do not run it on files that use the name sugar after an attribute value.

- **Changed (name-sugar-core, decision 146):** bare `:x` is `name="x"` sugar, as `#x` is `id` and `.x` is `class`, in every position (`<input type="email" :email>`, `<input:email>`). Marko's `value:x` is still written `value:x`. The `attr-value-modifier` oracle fixture now writes it that way. See `divergences.md`.

- **Changed (default-tag-contracts r3):** the Marko core taglib moved to `@mxlang/core` (`CORE_TAGLIB`); no behaviour change.

- **Fix (default-tag-contracts r2):** `loadMx`, nested tags, the Bun loader and the example runner run the contracts' `defaultTag` registration check and warn once at the declaring file; an invalid contract value no longer compiles to the wrong element (`input`) and the next rung answers.

- **Added (default-tag-contracts, decision 145):** the unnamed tag resolves through the parent's contract `defaultTag` first, then `mx.html.defaultTag`, then `div`.

- **Fix (default-tag-ladder r2):** `loadMx`, `mx` (with a `filename`) and nested tags read the package's validated `mx.html.defaultTag` and put it in their cache keys, so an edited config recompiles; the Bun loader and the example runner validate it (core's `ownDefaultTag`) and warn once at the `package.json` value.

- **Added (default-tag-ladder, decision 145):** the descriptor declares `defaultTag: "div"` and the policy's `resolveDefaultTag` answers `mx.html.defaultTag` first, then `div`; `compile` takes `defaultTag` and the Bun loader reads the package's key. The compile cache fingerprint includes it. Every existing template is byte-identical.

- **Feat (default-tag-core, decision 145):** declares `resolveDefaultTag: () => "div"`, the interim answer for the unnamed tag until the registry ladder lands. Output is byte-identical.

- **Test (range-loop-name-collision):** pinned, with no code change, that this host never had the range-mapper shadowing bug the JSX, Solid and Astro hosts had. A range binds its own `__mxForN` temporaries for `from`/`to` *before* the `for` opens, so no generated binding is ever in scope where an authored expression is evaluated; `step=` is rejected outright. Rendered regressions guard the shape.
- **Fix (html-direct-null-attr-empty):** omit native `null`, `undefined` and `false` attributes on direct, bound, colon, merged-spread and dynamic-native paths. Preserve `true`, zero, empty strings and NaN as Marko does, including `aria-*` and `data-*`. Class/style primitive presence, controlled direct `input.checked`, and dynamic void tags now match real Marko 6.3.51 renders. Expressions still run once, and the single hoisted native-value guard remains active.

- **Fix (reserve-mx-identifiers):** private render helpers, buffers and temporaries now use the reserved `__mx` prefix, including attribute-writer capture, structured-text and spread locals. The public `escape` export is unchanged and generated imports alias it privately. Authored bindings with the old helper names no longer shadow generated code.

- **Fix (attr-value-parity review):** validate duplicate `<let>` values before default policy drops the builtin. Hoist one native value guard per module; reject runtime functions/symbols with Marko's debug diagnostics. Null/false serialization is unchanged.

- **Fix (attr-value-parity):** ordinary native attributes, including spreads and dynamic string tags, throw Marko's render-time diagnostic for unrenderable objects instead of emitting `[object Object]`. Validate only final surviving merged values and evaluate authored values once. Existing class/style, controlled-value and direct-null behavior is unchanged.

- **Fix (colon-attr-followups round 3):** native reserved-prefix diagnostics use Marko's exact fix-it, taking the first head and the full remainder: `class:foo:bar` suggests `class={ foo:bar: condition }`, `style:foo:bar` suggests `style={ foo:bar: value }`, and `on:foo:bar` suggests `onFoo:bar`. Authored positions are unchanged.

- **Fix (colon-attr-followups round 2):** preserve ordinary nonempty colon names such as `x:foo` and `data:x`; reject ordinary native colon-name methods/functions with Marko's exact text and position rather than event-runtime advice. Restore `<input checked:/>` before the oracle fixture's spread element so its resume marker remains terminal.

- **Fix (colon-attr-followups):** ordinary empty-suffix names such as `x:` retain their colon for static, dynamic and valueless attributes. The stock-Marko oracle fixture pins rendered parity. Invalid literal bindings on dynamic tags and controls now fail through core rather than compiling silently.

- **Fix (proto-names): a tag named after an `Object.prototype` member (`<toString/>`, `<constructor/>`, …) no longer crashes the compile with a raw `TypeError`.** It is treated like any other tag name; the fix is in core, html has no code change.

- **Fix (hint-followups round 2):** the default target's `$ let`/`$ var` hint still suggests `<let/name=…/>`, now explicitly followed by `(initial value only on this target)`. The qualifier is declared by html, not core; const advice and strict-policy behaviour are unchanged.

- **Fix (scriptlet-hint-let-var):** `$ let`/`$ var` now suggest `<let/name=…/>` on the default initial-value target, not `<const>`. Strict mode rejects `<let>` and omits keyword advice for mutable declarations. `$ const` advice is unchanged; no rendering semantics changed.

- **Test (no-repeat-path-relative-spellings):** `error-no-repeated-path.test.ts` pins that a `TranslateError` message drops the compiled-file prefix for a *relative* `filename` and a filename under a symlinked directory, not only the exact absolute spelling. The fix is in `@mxlang/core`'s `dropCompiledFilePrefix` (resolve/realpath comparison); no html code changes.

- **Fix (jsx-whitespace-body-parity, decision 141):** imported components and discovered `tags/*.mx` now forward same-line whitespace-only bodies as one space, matching Marko 6.3.51 through the shared core body-presence fix. Newline indentation remains absent. Pinned by rendered output, including tabs, CRLF and comments beside whitespace.

- **Changed (refactor/target-open-set, decision 137):** the Bun loader excludes a dotted tag file name from the tag map with a positioned diagnostic, as `@mxlang/core`'s scan does. The loader is a direct entry, so it resolves its targets from this package's own descriptor unless a caller passes a lookup (`createHtmlBunPlugin(targets)`); either way a foreign `tags/x.ng.mx` is rejected. Only full-registry tooling validates unknown bare words in `mx.tags[].hosts`; this direct loader leaves peer restrictions unresolved without a warning (PR 3 round-2 ruling). Package specifiers stay silent.
- **Changed (refactor/target-open-set, decisions 129 and 132):** `compile`/`compileFile`/`build`/`loadMx`/`mx()` accept `options.targets`, defaulting to this package's own descriptor (`htmlTargets`, now exported). A tool compiling for several targets passes the built-in lookup.

- **Added (fix-hints-batch, audit item 14):** an unresolved capitalized tag now ends ``Import it (`import Card from "./Card.mx"`) or add `tags/Card.mx`.``, or ``Did you mean `<Badge>`?`` when an import or `<define>` is one or two edits away; an unresolved lowercase tag near an HTML element ends ``Did you mean `<div>`?`` (`<dvi>`). Parse-error and scriptlet hints come from `@mxlang/core`. `(click)="…"` is unchanged: this host has no event handlers to suggest.


- **Changed (amx-to-astro-mx, decision 134):** the Bun loader's file filter also declines `x.astro.mx`, Astro's template kind, as it already declines `x.solid.mx`.

- **Added, unstable (target-registry, decisions 129 and 132):** `./descriptor` subpath exports the `html` target descriptor (`src/descriptor.ts`): no host, `legacyHostValues` `html` and the deprecated `translator`, the policy and strict policy as `declarations`, and a lazy `translator`. `load()` returns the existing `compile`. Also built into `dist/descriptor.{js,d.ts}`. Nothing consumes it yet; see `@mxlang/target-registry`.

- **Fix (dup-attr-last-wins-core round 2, decision 135):** a repeated attribute next to a spread now resolves last-wins as an object merge does. `<div a=1 ...x a=2>` used to print `a` twice (x's first), so a browser kept x's value; the spread now skips keys a later explicit attribute names (or a later spread supplies) and an explicit attribute is skipped when a later spread has the key. Attributes after the last spread are written first, as Marko does. The `<input>` `value`-first reorder moved from the `orderAttrs` hook (which reordered the IR across spreads) to emission. Pinned by rendering tests and the `duplicate-attrs*` stock oracle fixtures.
- **Fix (dup-attr-last-wins-core round 2, decision 135):** a repeated attribute next to a spread now resolves last-wins as an object merge does. `<div a=1 ...x a=2>` used to print `a` twice (x's first), so a browser kept x's value; the spread now skips keys a later explicit attribute names (or a later spread supplies) and an explicit attribute is skipped when a later spread has the key. Attributes after the last spread are written first, as Marko does. The `<input>` `value`-first reorder moved from the `orderAttrs` hook (which reordered the IR across spreads) to emission. Pinned by rendering tests and the `duplicate-attrs*` stock oracle fixtures.

- **Fix (dup-attr-last-wins-core round 4):** the merged attribute object is one object literal with spread syntax (`{ ...a, ...x, ...b }`) instead of `Object.assign`, so a spread's own enumerable `__proto__` key (for example from `JSON.parse` of untrusted input) is kept as an attribute, as on main's lone-spread path and in Marko, rather than being dropped or becoming the object's prototype. An explicit attribute named `__proto__` is still dropped, as before.

- **Fix (dup-attr-last-wins-core round 3, decision 135 addendum):** a tag with a spread now follows Marko's shape and evaluation order: the attributes written after the last spread are evaluated and written first, everything before is ONE object built in authored order (`Object.assign({}, {a: f()}, x, {b: g()}, y)`), so an attribute runs before the spread that follows it (`title=setk() ...box` sees `box.k === "k2"`, as in Marko), a key keeps its earlier slot when a spread overwrites it, a `null`/`undefined` spread (leading or not) is ignored instead of throwing, and `<input>` with a spread keeps authored order (the value-first hoist applies only without a spread; it is no longer an index into a permuted order). Cost: one object per render for a tag with a spread, none for a lone spread with nothing before it. No remaining divergence from Marko in value or order on the probed shapes; strings/arrays as a spread are skipped silently where Marko raises.

- **Fix (dup-attr-last-wins-core round 2, decision 135 and its spread-precedence addendum):** attributes written after a spread now win over the spread, as in Marko (`<div ...x id="p">` renders `id="p"` even when `x.id` is set; it used to print both and a browser kept the spread's). Emitted attribute order may change. a repeated attribute next to a spread now resolves last-wins as an object merge does. `<div a=1 ...x a=2>` used to print `a` twice (x's first), so a browser kept x's value; the spread now skips keys a later explicit attribute names (or a later spread supplies) and an explicit attribute is skipped when a later spread has the key. Attributes after the last spread are written first, as Marko does. The `<input>` `value`-first reorder moved from the `orderAttrs` hook (which reordered the IR across spreads) to emission. Pinned by rendering tests and the `duplicate-attrs*` stock oracle fixtures.

- **Fix (dup-attr-last-wins-core, decision 135):** `<div class="a" class="b">` now emits only `class="b"`; before, both were emitted and a browser kept the first. The earlier occurrence gets a positioned warning naming the surviving one. See `@mxlang/core`.

- **Breaking (delegated-tag-rename, decision 132):** follows the `@mxlang/core` rename of `claimsTag`/`resolveHostTag`/`HostTag`/`ctx.build.hostTag` to `isDelegatedTag`/`resolveDelegatedTag`/`DelegatedTag`/`ctx.build.delegatedTag`; the host's `Emitter.hostTag` method is now `delegatedTag`. No output or diagnostic change.

- **Fix (audit-02-for-by-parity):** `<for by=x.id>` (any read of a loop param in `by=`) is now a positioned error, as in Marko 6.3.51, instead of passing silently. See `@mxlang/core`.

- **Fix (audit-01-prop-attr-parity):** an attribute name outside Marko's grammar (`[prop]=`, `#ref`, `*ngIf`) is now a positioned "Invalid attribute name" error, as in Marko 6.3.51, instead of passing through. See `@mxlang/core`.

### Fix: `mx()`/`loadMx()` on Bun no longer fail with `NameTooLong` for larger or nested templates (test-bun-example-nametoolong)

On Bun, `mx()`/`loadMx()` evaluated each compiled module as a `data:text/typescript;base64,…` URL. Bun before 1.4 (1.3.14 measured) fails such a `require` with `NameTooLong while resolving package 'data:…'` once the URL passes about 1.5 KB, and a nested tag's URL is embedded base64-in-base64 in its importer, so any page that called a tag could hit it. On Bun the helpers now load compiled modules through a `Bun.plugin` virtual-module namespace (`mx-virtual:`, the same versioned scheme Node already used), registered once per process; the plugin is process-global but only answers `mx-virtual:` names. Node is unchanged. Compiled modules are kept for the process lifetime, as before. `src/helpers.bun.test.ts` (in `test:bun`) now covers a large single template and a large page importing a large nested tag.

### Fix: a page calling a `tags/*.marko` tag imports it (html-tags-marko-import)

An html-host page calling a tag from `tags/*.marko` emitted a bare `badge({...})` with no import, so it threw `ReferenceError: badge is not defined` at run time (and `<fancy-btn/>` emitted the invalid `fancy - btn(...)`). The module now imports the tag the way Marko 6.3.51 does: `import _badge from "./tags/badge.marko"`, a default import with the extension kept, relative to the page, named `_` plus the camelCased tag name, once per module. Discovery is Marko's own (nearest `tags/` per name up to the package root, `tags/x/index.marko` before `tags/x.marko`). A same-name `tags/x.mx` still wins over `tags/x.marko` regardless of distance (an mx-only rule, recorded in `divergences.md`). `bun run example` and the oracle's `translator-render.ts` no longer inject the import themselves. `src/marko-tags.bun.test.ts` (in `test:bun`) renders real `.mx` pages through Bun; `src/marko-tags.test.ts` pins the emitted import. No golden changes.

### Fix: `bun run example <fixture>` runs again (html-readme-example-nested-layout)

Every example, `class-object` and `nested-layout` included, died with `SyntaxError: Unexpected token ':'`. `src/example.ts` executed the compiled module by regex-stripping its `import`s and `export default function (input: Input): string {` line, a shape the emitter stopped producing when the module became a named, branded `function Input(input: Input): string`. It now runs the real emitted module through Bun's loader instead of matching its text, applies `tags/` discovery, and so cannot drift from the emitter again. `src/example.bun.test.ts` (in `test:bun`) runs the script against every fixture stock Marko compiles and checks the README's named examples are among them.

### Fix: the tarball no longer ships `dist/example.js` (html-ships-example-js)

`src/example.ts` (the `bun run example` demo) was a `bun build` entry, so its bundle landed in `dist/` and in the tarball although nothing exports it. It is no longer built: `bun run example` now runs the source directly (`bun src/example.ts`, no build step). The `exports` map and the emitted declarations are unchanged. `scripts/pack-hygiene.test.ts` now pins the exact set of `dist/` files the tarball may contain.

### Fix: `@mxlang/html/bun` typechecks for a consumer with `skipLibCheck: false` (pkg-types-g10)

`dist/bun.d.ts` has `import type { BunPlugin } from "bun"`, but `bun` was not a declared dependency, so a strict consumer of the `./bun` subpath got `TS2307: Cannot find module 'bun'`. `@types/bun` is now an **optional peer dependency** (`>=1.3`): only a consumer of `./bun` runs Bun, and a consumer of `.` needs nothing. The README's Loaders section says so.

### Added: `@mxlang/html/types/marko` export (pkg-types-g10)

`types/marko.d.ts` (the ambient `declare module "*.mx"`) shipped in the tarball but the `exports` map blocked it, so the only way in was a `/// <reference path="node_modules/…">`. It is now `"./types/marko"`; `import "@mxlang/html/types/marko"` types `import page from "./page.mx"`.

### Fix: the tarball no longer ships `.d.ts.map` files (pkg-types-g10)

`tsconfig.build.json` sets `declarationMap: false` (the maps pointed at unpublished `../src/*.ts`) and excludes `src/**/fixtures/**`.

### Added: `mx(source)`/`loadMx(path)` — bundler-free compile, cache and execute (html-mx-helpers)

`mx()`/`loadMx()` compile a template once, resolve every import in the compiled output to a real absolute target, and evaluate the result synchronously, in memory, with zero disk writes — on Bun (`require` of a `data:` URL) and on Node ≥22.15 (`node:module`'s `registerHooks`, plus its experimental `stripTypeScriptTypes`). Pug-style ergonomics (`compile`/`renderFile`) for an Express/Hono/plain-Bun consumer with no bundler step: `loadMx(path)` caches by resolved path and every transitive dependency's mtime, `mx(source, { filename? })` by a hash of source plus filename, both bounded LRU-256. A discovered custom tag's own `.mx` import is compiled recursively through the same cache, so a page whose tag itself imports another `.mx` file invalidates on the deepest file's change, not just the page's own. `mx(source)` needs `filename` (an anchor to resolve against) whenever the template has any import of its own; `loadMx`'s own path already is that anchor. An import cycle across `.mx` files is a compile-time error naming the cycle; a nested compile error is reported against the nested file's own path and position. See `README.md` for the full contract, including two Node-only caveats: one `ExperimentalWarning` per process from `stripTypeScriptTypes` (not per call), and unbounded `require`-cache growth under heavy template-edit churn in a long-lived process (bounded by how often templates are actually edited).

### Internal: uses core's shared `unresolvedCustomTagMessage` (source-bindings-silent-parse-failure)

`rejectUnknownTag`'s Marko-wording message ("Unable to find entry point for custom tag `<Name>`.") now comes from `@mxlang/core`'s `unresolvedCustomTagMessage` instead of a hand-copied literal. No behavior change.

### Fix: `renderDynamic` no longer drops body content for a falsy dynamic-tag target (decision 116)

`renderDynamic(target, props, args)` returned `""` for `null`/`undefined` `target`, discarding the tag's own body content entirely. Marko's own `_dynamic_tag`/`normalizeDynamicRenderer` treat a falsy target as "no renderer" and render only the body, independent of the target — `renderDynamic` now does the same, returning `props.content?.() ?? ""` instead of `""` outright. Surfaced by decision 116's routing, which sends every non-`.marko`/`.mx` value import through this path far more often than the authored `<${expr}/>` syntax alone did.

Policy (decision 65, 67): the target renders what Marko's own server render
would emit, minus resume markers — `<let>`/`<const>`/`:=` evaluate their
initial value, `<effect>`/`<lifecycle>`/`<script>`/`client`/`<id>` are inert,
a `server` block runs and hoists, and `<await>`/`<try>`-with-`<@placeholder>`/
`<return>` error because a synchronous `(input) => string` genuinely cannot
express them. An opt-in `strict` policy instead rejects the reactive
constructs by name. Attribute values are always double-quoted rather than
byte-matching Marko's quote-minimizer — the oracle compares parsed, decoded
attributes, not source bytes, so the two are already semantically identical
and the always-quoted form is safer and more readable.

- **fix:** a dynamic tag or `<define>` call now accepts arguments plus content
  (decision 109). `renderDynamic`'s runtime forwards the trailing props object
  alongside a dynamic tag's arguments when there is content or an attribute
  tag to carry, matching Marko's `renderer(...args, { content, <attribute
  tags> })` shape. A `<define>` call combines the tag-argument form with a
  body or attribute tags by extending its existing positional named-lookup
  scheme (used for the no-args call shape): params beyond the consumed args
  are filled from the same named lookup. Arguments plus a plain attribute are
  still rejected.
- **fix (behavior change, decision 112):** a **string-target** dynamic tag
  called with arguments now uses `args[0]` as its input (attributes),
  matching Marko's own `_dynamic_tag` (`runtime-tags/src/html/dynamic-tag.ts`
  and the dom equivalent). Previously `renderDynamic` ignored `args`
  entirely for a string target and rendered the call site's own
  attributes/attribute tags instead — always empty, per the args/plain-attr
  exclusivity rule, so the element rendered with no attributes regardless of
  what was passed. A null/undefined `args[0]` is treated as `{}`; extra
  arguments beyond `args[0]` are ignored; decision 109's trailing props
  object is appended *after* the positional args, so it is never `args[0]`
  and its attribute-tag values are not read as input — content still
  renders, since Marko threads it independently of the input.
- **fix:** a lowercase tag naming a local binding (`import layout from
  "./layout.marko"` then `<layout>`) now errors with Marko's own message
  ("Local variables must be in a dynamic tag unless they are PascalCase...")
  instead of being called directly. `<${layout}/>` and `<Layout/>` are
  unaffected.
- **fix:** an unresolved hyphenated tag (`<my-widget>` with no taglib entry)
  now errors with Marko's own message ("Unable to find entry point for
  custom tag...") instead of rendering as literal HTML.
- **fix:** `<log>` and `<debug>` are now rejected by name under the `strict`
  policy (decision 111), matching the other reactive/debug-only tags
  (`<let>`, `<effect>`, `<lifecycle>`, `<script>`, `client`, `<id>`).
  Previously `STRICT_TAGS` did not override these two rows, so they stayed
  inert under `{ strict: true }` — and therefore under the Astro `.mx` host
  too, which always compiles under `strictPolicy`. Non-strict behavior is
  unchanged: `<log>`/`<debug>` are still inert there.
- **breaking:** an expression-valued event attribute on an element
  (`onClick=fn`, `on-my-event=fn`) is now a compile error naming the
  attribute — an event handler requires a runtime, and this host renders
  once to a string (decision 101, phase B of `dom-events`). Previously it
  silently emitted dead inline JS. A *string*-valued `onclick="alert(1)"`
  stays an ordinary attribute verbatim; a bare `onClick` stays boolean.
  `on:`/`oncapture:` now reject with a fix-it naming `on-<exact>`.
- **breaking:** attribute-tag values now follow the consumer-declared
  decision-106 shape. `data` tags receive attributes and nested tags plus an
  optional `content: (...params) => string`; `renderable` tags receive that
  render function directly; repeated/looped tags are real arrays. The host
  exports its specialized one-parameter `AttrTag<C>` type.
- **breaking:** decision 108 restores a bare renderable fallback for an
  untyped attribute-tag property when every occurrence is body-only. Any
  attributed or nested occurrence keeps the whole fallback property data;
  declared shapes and cardinality are unchanged.
- **fix:** data attribute-tag values called through an untyped dynamic target
  now fail with an actionable `content`-route diagnostic instead of an opaque
  "target is not a function" error. Declared tag-param types also survive
  conditional and looped array emission under strict TypeScript, and one-param
  `for in` loops no longer shadow an outer binding named `value`.
- **build:** publishable from `dist/` (ESM + `.d.ts`); `exports` map for
  `.` and `./bun`.

- **chore:** renamed scope from `@markox` to `@mxlang` (decision 74).
