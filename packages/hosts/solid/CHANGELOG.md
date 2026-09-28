# Changelog

## Unreleased

### Fixed

- `<define>` is supported inside a `.solid.mx` region (decision 110b).
  Previously a compile error: `` `<define>` cannot declare a function
  inside a JSX expression; declare it in the surrounding TypeScript module
  ``, on every `<define>` written inside a `.solid.mx` region,
  unconditionally.

  A top-level `<define>` inside a region now hoists to a gensym'd
  module-scope function, the same way `compileSolidMx` already hoists a
  discovered tag's synthesized import — `CompileSolidMxResult` gained a
  matching `hoistedDefines` field, and `@mxlang/parser`'s bridge writes both
  into the surrounding module. After hoisting, decision 109's `<define>`
  call shapes (no arguments, arguments, attribute tags, arguments plus
  content and attribute tags) apply on Solid too, through a plain
  function-call expression at the call site (`{$mx_DefineRowN(...)}`)
  rather than a JSX tag — JSX has no positional-call syntax, so this
  differs from every other `Component` target on this host, which prints
  an ordinary `<Tag .../>` element.

  Two constructs a hoisted `<define>` cannot express, both reported as a
  positioned error rather than silently wrong code:

  - **Nested inside `<if>`/`<for>`/an attribute tag/another `<define>`.**
    Only a direct top-level child of the region hoists; module scope has no
    per-row or per-branch scope for a nested one to close over.
  - **Closing over a value local to the region** — a binding from the
    surrounding TypeScript function the region lives in (a signal from
    `createSignal`, a prop). A hoisted `<define>` becomes a real
    module-scope function and can only reference its own params, another
    top-level `<define>`'s name, and the module's own imports.

  See `packages/hosts/solid/AGENTS.md` and
  `apps/docs/docs/specification.md` §5.4 for the full contract, and the new
  `fixtures/define-hoist` oracle fixture (recorded as a documented
  `divergences.md` entry: MX's gensym'd function names can never byte-match
  a hand-written twin's natural names, verified semantically identical
  otherwise).

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
