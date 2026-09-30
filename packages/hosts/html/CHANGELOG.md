# @mxlang/html

## 0.1.0 (unreleased)

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
