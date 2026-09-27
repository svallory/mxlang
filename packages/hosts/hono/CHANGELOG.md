# @mxlang/hono

## 0.1.0 (unreleased)

- **breaking:** attribute tags now follow the callee-declared decision-106
  shape through the shared JSX emitter. The package exports `AttrTag<C>`
  specialised to Hono's `Child`.
- **breaking:** decision 108 passes an untyped body-only attribute-tag prop as
  a bare Hono child. Any attributed or nested occurrence keeps that fallback
  property data-shaped; declared shapes and cardinality are unchanged.
