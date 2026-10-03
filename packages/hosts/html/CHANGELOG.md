# @mxlang/html

## 0.1.0 (unreleased)

- **Changed (amx-to-astro-mx, decision 134):** the Bun loader's file filter also declines `x.astro.mx`, Astro's template kind, as it already declines `x.solid.mx`.

- **Added, unstable (target-registry, decisions 129 and 132):** `./descriptor` subpath exports the `html` target descriptor (`src/descriptor.ts`): no host, `legacyHostValues` `html` and the deprecated `translator`, the policy and strict policy as `declarations`, and a lazy `translator`. `load()` returns the existing `compile`. Also built into `dist/descriptor.{js,d.ts}`. Nothing consumes it yet; see `@mxlang/target-registry`.

- **Fix (dup-attr-last-wins-core round 2, decision 135):** a repeated attribute next to a spread now resolves last-wins as an object merge does. `<div a=1 ...x a=2>` used to print `a` twice (x's first), so a browser kept x's value; the spread now skips keys a later explicit attribute names (or a later spread supplies) and an explicit attribute is skipped when a later spread has the key. Attributes after the last spread are written first, as Marko does. The `<input>` `value`-first reorder moved from the `orderAttrs` hook (which reordered the IR across spreads) to emission. Pinned by rendering tests and the `duplicate-attrs*` stock oracle fixtures.
- **Fix (dup-attr-last-wins-core round 2, decision 135):** a repeated attribute next to a spread now resolves last-wins as an object merge does. `<div a=1 ...x a=2>` used to print `a` twice (x's first), so a browser kept x's value; the spread now skips keys a later explicit attribute names (or a later spread supplies) and an explicit attribute is skipped when a later spread has the key. Attributes after the last spread are written first, as Marko does. The `<input>` `value`-first reorder moved from the `orderAttrs` hook (which reordered the IR across spreads) to emission. Pinned by rendering tests and the `duplicate-attrs*` stock oracle fixtures.

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
