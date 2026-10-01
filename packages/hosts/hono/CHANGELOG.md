# @mxlang/hono

## 0.1.0 (unreleased)

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
