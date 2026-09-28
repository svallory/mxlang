# Changelog

## Unreleased

### Internal

- `rejectUnknownTag`'s Marko-wording message (`source-bindings-silent-parse-failure`)
  now comes from `@mxlang/core`'s `unresolvedCustomTagMessage` instead of a
  hand-copied literal. No behavior change. Confirmed separately: a
  module-level syntax error in the surrounding `.solid.mx` module (next to
  a genuinely imported component) already surfaces as the real syntax
  error through the real `parse()` pipeline (`collectModuleScope`'s own
  uncaught `babelParse`), never the misleading "Unable to find entry point"
  fallback — pinned by a new test in `@mxlang/parser`'s `mx.test.ts`.

### Fixed

- A non-import module-scope local used as a tag whose value is not statically
  a function/arrow/class now lowers as a dynamic tag too (local extension of
  decision 116, firstmate's ruling). `CompileSolidMxOptions` gained
  `unknownModuleBindings?: ReadonlySet<string>`, folded into
  `ctx.unknownLocalValue` alongside the existing `moduleBindings` fold; a
  plain `function Foo(){}`/arrow-valued `const` keeps its pre-existing direct
  JSX call, unchanged. A `<const>` region binding is classified the same way
  from its own value expression, and a `<for>`/`<define>` tag param is always
  classified unknown, since its runtime value can never be inspected at
  lowering time.

- A value import that is not a `.marko`/`.mx` default import now lowers as a
  dynamic tag (decision 116), matching Marko's own `_dynamic_tag` runtime
  dispatch — a string renders as an element, `undefined`/`null` render only
  the tag's body content (previously the dynamic-tag guard discarded the
  body outright for any falsy target — Marko renders it), and a plain
  function is still called as a host component (an intentional divergence:
  an imported `.tsx` component IS a plain function). Typed attribute-tag
  checking on such a call still resolves the real callee's `Input` through
  the target's new `valueImportBinding`, exactly as a direct call does.
  `@mxlang/parser`'s module-scope scan (`collectModuleScope`) now also
  tracks which import bindings are `.marko`/`.mx` defaults
  (`mxImportDefaultFromMarkoOrMx`, threaded through `MxRegionCompile`) so a
  real `.solid.mx` region resolves the same way a unit test does. A region
  whose entire content is one dynamic tag used to fail to re-parse
  ("Unexpected token") because the compiled JSX child-expression-container
  braces (`{(() => {...})()}`) are not a standalone expression on their
  own; the bridge now retries the parse with those braces stripped when the
  first attempt fails.
- A type-only import (`import type Widget from "./widget.mx"`, or
  `import { type Widget } from "..."`) no longer resolves `<Widget/>` as a
  component: it now reaches Marko's own unresolved-tag compile error, on
  every whole-file `.mx` entry point (`compileSolidUnit`) as well as every
  other host, since the fix is in `@mxlang/core`'s shared import-binding
  resolution (decision 114/115). A type-only import is still emitted
  verbatim.
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

- An unresolved capitalized tag is now a compile error, matching Marko
  (decision 114). `isComponent` (`emitter.ts`) was a bare `/^[A-Z]/` test
  with no resolvability check — any unresolvable capitalized tag
  (`<TotallyUndefined/>`, or a self-recursive `<define>` before its own
  name is registered) silently lowered as an ordinary component call and
  printed a bare JSX reference to a binding nothing declares, a runtime
  `ReferenceError` rather than a positioned MX error. It now returns `true`
  only when the name genuinely resolves: through the surrounding
  TypeScript module's own top-level value bindings (an import or a
  top-level `const`/`function`/`class`, type-only bindings excluded), or
  one of Solid's own JSX built-ins (`Show`, `For`, `Switch`, `Match`,
  `Repeat`, `Errored`, `Loading`, `Dynamic`). Everything else reaches
  Marko's own positioned error (`` Unable to find entry point for custom
  tag `<Name>`. ``, verified against `@marko/compiler` 5.42.5 /
  `marko@6.3.51`) through a new `rejectUnknownTag` declaration.

  **Behavior change**: a `.solid.mx` template (or whole-file `.mx`
  resolved to the Solid host) that previously compiled to a dangling JSX
  reference for an unresolvable capitalized tag now fails to compile
  instead, naming the tag. A whole-file `.mx` compiled to Solid still
  cannot use an authored `import` for such a name (a separate,
  pre-existing limitation — `compileSolidMx` rejects any module-level
  statement outside a real `.solid.mx` region); a registered custom tag is
  the resolution route available there.

### Breaking

- Attribute tags now follow the callee-declared `AttrTag` cardinality and
  shape. Solid renderables are reusable accessors: `() => JSX`, or
  `(...params) => () => JSX` for parameterized tags. Data-shaped tags carry
  that accessor under `content`; arrays, control flow, attributes and nested
  tags are preserved.

### Added

- `compileSolidUnit` now returns the same full result shape as
  `compileSolidMx`: `map`, `mappings`, `dependencies` and a `warnings` sink
  option, driven by the same `emitSolidWithMappings` mapping story (decision
  115). Previously it returned only `{ code }`, which was enough to compile
  a whole-file `.mx` to a Solid component but left every consumer needing
  correct diagnostic positions or dependency-based HMR invalidation with
  nothing to read. `hoistedImports`, `hoistedDefines` and `returnVars` are
  always empty here — those exist only for a `.solid.mx` *region*, spliced
  into someone else's module; a tag unit is a whole file with its own
  module scope.
- Export `AttrTag<C>`, specialised to Solid's accessor renderable.
- Resolve imported callees inside `.solid.mx` regions and report their files
  as compile dependencies for Vite invalidation.
- Escape root interpolations in reusable renderables and lazy control-flow
  bodies during SSR without sacrificing client reactivity.
- Diagnose parameterized attribute-tag values rendered without arguments and
  data-shaped values rendered without their `.content` accessor.
