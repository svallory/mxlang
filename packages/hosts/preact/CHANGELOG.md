# @mxlang/preact

## 0.1.0 (unreleased)

- **breaking:** attribute tags now follow the callee-declared decision-106
  shape. Data tags receive `{ ...attrs, ...nestedProps, content }`, renderable
  tags receive the body, arrays are real arrays, and conditional/loop tag
  expressions are evaluated during the caller's render. The package now
  exports Preact-specialised `AttrTag<C>`.
- **breaking:** decision 108 passes an untyped body-only attribute-tag prop as
  a bare renderable. Any attributed or nested occurrence keeps that fallback
  property data-shaped; declared shapes and cardinality are unchanged.
