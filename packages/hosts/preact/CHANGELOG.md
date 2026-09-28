# @mxlang/preact

## 0.1.0 (unreleased)

- **Internal (source-bindings-silent-parse-failure):** `rejectUnknownTag`'s
  Marko-wording message now comes from `@mxlang/core`'s
  `unresolvedCustomTagMessage` instead of a hand-copied literal. No behavior
  change; shared with `@mxlang/react`/`@mxlang/hono` through the common
  emitter.
- **Fixed:** `mxDynamic` (the shared Preact/React/Hono JSX emitter's
  dynamic-tag helper) now treats a host-recognized component object as a
  component. React's own `memo(Foo)`/`forwardRef(...)` return plain objects
  (`{ $$typeof: Symbol(react.memo), ... }`), not functions, and used to fall
  through `mxDynamic` unrecognized, handing the bare object back as a JSX
  child (React: "Objects are not valid as a React child"). New
  `mxIsHostComponentObject(value)` helper, allowlisted by the marker
  symbol's `description` (`"react.memo"`/`"react.forward_ref"`/
  `"react.lazy"`) rather than merely "carries a `$$typeof` symbol" — every
  React *element* (an ordinary already-rendered node, not just a `memo`/
  `forwardRef` wrapper) also carries one, which misclassified plain rendered
  content as a component. Checked before decision 106's `.content`-guard so
  a recognized object never reaches it. Reachable both as a local
  (`static const Comp = memo(Foo)`) and as a value import. Preact's own
  `memo`/`forwardRef` (real functions, unlike React's) were already
  unaffected; React's raw object form imported directly into a Preact app
  remains unsupported regardless of this fix — measured, Preact's own
  renderer has no object-based component dispatch at all, with or without
  MX. See the spec's decision 116 section for the full detail.

- **Fixed (behavior change, decision 114 parity, `unresolved-tag-jsx-astro-angular`):**
  `<TotallyUndefined/>` — a capitalized tag with no import, binding, or taglib
  entry — now fails to compile with Marko's own error ("Unable to find entry
  point for custom tag `<TotallyUndefined>`."), matching `@mxlang/html` and
  `@mxlang/solid` (decision 114). `isComponent` (`emitter.ts`, shared by
  `@mxlang/react` and `@mxlang/hono`) used to fall back to a bare
  `isComponentName` (`/^[A-Z]/`) casing test whenever the taglib lookup found
  nothing, so an unresolved capitalized tag silently emitted a JSX component
  reference to nothing — a runtime `ReferenceError`, not a compile error. The
  fallback is now `false`, and `rejectUnknownTag` reports Marko's wording
  through the existing `lower.ts` hook. A type-only import already did not
  resolve a tag (decision 114/115); unaffected by this change. A decision-116
  dynamic-tag-routed value import (below) is a distinct, in-scope binding and
  is unaffected — its `valueImportBinding` reaches `isComponent` through
  `ctx.imports` the same as any other import.
- **fix (decision 116):** a value import that is not a `.marko`/`.mx` default
  import now lowers through `mxDynamic` instead of a direct call — matching
  Marko's own `_dynamic_tag` dispatch for a string, `undefined`, `null`, or a
  plain object; an intentional divergence for a plain function, still called
  and its return kept, since an imported `.tsx` component (or an MX
  component on html) IS a plain function. Two host-side fixes needed for
  this to reach parity: `#propsObject`'s `owner` was unconditionally
  `undefined` for a `kind: "dynamic"` target, silently dropping typed
  attribute-tag checking for every such call — it now reads the target's
  `valueImportBinding` (core's new provenance field) the same way a
  `kind: "name"` target's own binding name is used. `mxDynamic`'s own
  parameters were implicitly `any` under `strict` TypeScript, which surfaced
  only once decision 116 started routing real imports through it far more
  often; both are now explicitly typed. `@mxlang/react` shares this through
  the common emitter.
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
- **fix (behavior change, decision 112):** a **string-target** dynamic tag
  called with arguments now uses `args[0]` as its input (attributes),
  matching Marko's own `_dynamic_tag`. Previously `mxDynamic` rendered a bare
  `<Tag />` for a string target with arguments, ignoring them entirely. A
  null/undefined `args[0]` is treated as `{}`; extra arguments beyond
  `args[0]` are ignored; decision 109's trailing props object is appended
  *after* the positional args, so it is never `args[0]` and its
  attribute-tag values are not read as input — `mxDynamic` gained a third
  `content` parameter so content still renders regardless, matching Marko's
  independent content channel. `@mxlang/react` and `@mxlang/hono` share this
  fix through the common emitter and runtime helper.
- **breaking:** attribute tags now follow the callee-declared decision-106
  shape. Data tags receive `{ ...attrs, ...nestedProps, content }`, renderable
  tags receive the body, arrays are real arrays, and conditional/loop tag
  expressions are evaluated during the caller's render. The package now
  exports Preact-specialised `AttrTag<C>`.
- **breaking:** decision 108 passes an untyped body-only attribute-tag prop as
  a bare renderable. Any attributed or nested occurrence keeps that fallback
  property data-shaped; declared shapes and cardinality are unchanged.
