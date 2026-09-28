# @mxlang/react

## 0.1.0 (unreleased)

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
