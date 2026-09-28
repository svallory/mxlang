# @mxlang/preact

## 0.1.0 (unreleased)

- **fix:** a dynamic tag or `<define>` call now accepts arguments plus content
  (decision 109). `mxDynamic`'s payload array carries a trailing props object
  after the arguments when there is content or an attribute tag to forward,
  matching Marko's shape (unchanged runtime, since it already spread the
  whole payload into the call). A `<define>` call combines the tag-argument
  form with a body or attribute tags by extending its existing positional
  named-lookup scheme: params beyond the consumed args are filled from the
  same named lookup used for the no-args call shape. Arguments plus a plain
  attribute are still rejected. `@mxlang/react` and `@mxlang/hono` share this
  fix through the common emitter.
- **breaking:** attribute tags now follow the callee-declared decision-106
  shape. Data tags receive `{ ...attrs, ...nestedProps, content }`, renderable
  tags receive the body, arrays are real arrays, and conditional/loop tag
  expressions are evaluated during the caller's render. The package now
  exports Preact-specialised `AttrTag<C>`.
- **breaking:** decision 108 passes an untyped body-only attribute-tag prop as
  a bare renderable. Any attributed or nested occurrence keeps that fallback
  property data-shaped; declared shapes and cardinality are unchanged.
