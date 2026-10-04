# @mxlang/react

- **Fix (marko-parity-trio, `:modifier`):** `<div :foo="y"/>` compiles to the JSX attribute `value:foo={y}`, Marko's own attribute (MX previously rejected it).

## 0.1.0 (unreleased)

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
