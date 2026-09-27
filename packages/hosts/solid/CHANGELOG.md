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
