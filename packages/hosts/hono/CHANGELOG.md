# @mxlang/hono

## 0.1.0 (unreleased)

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
