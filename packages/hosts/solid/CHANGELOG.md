# Changelog

## Unreleased

### Breaking

- Attribute tags now follow the callee-declared `AttrTag` cardinality and
  shape. Solid renderables are reusable accessors: `() => JSX`, or
  `(...params) => () => JSX` for parameterized tags. Data-shaped tags carry
  that accessor under `content`; arrays, control flow, attributes and nested
  tags are preserved.

### Added

- Export `AttrTag<C>`, specialised to Solid's accessor renderable.
- Resolve imported callees inside `.solid.mx` regions and report their files
  as compile dependencies for Vite invalidation.
- Escape root interpolations in reusable renderables and lazy control-flow
  bodies during SSR without sacrificing client reactivity.
- Diagnose parameterized attribute-tag values rendered without arguments and
  data-shaped values rendered without their `.content` accessor.
