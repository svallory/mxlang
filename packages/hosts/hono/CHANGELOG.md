# @mxlang/hono

## 0.1.0 (unreleased)

- **Changed (refactor/target-open-set, decision 137):** the Bun loader excludes a dotted tag file name from the tag map with a positioned diagnostic, and reports an unknown bare word in `mx.tags[].hosts` (silent for a package specifier). The loader resolves its targets from this package's own descriptor unless a caller passes a lookup (`createHonoBunPlugin(targets)`).
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
