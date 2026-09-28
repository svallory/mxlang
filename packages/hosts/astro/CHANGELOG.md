# Changelog

## Unreleased

### Added

- Attribute-tag IR v2 support for singular named slots, including mutually
  exclusive `<if>`/`<else if>`/`<else>` branches, the Astro-specialized
  `AttrTag<C>` type, and its automatic `.amx` type import.

### Fixed

- **`source-bindings-silent-parse-failure` (filed from the PR #156 review):**
  a syntax error in the `---` fence used to be silently swallowed by
  `sourceBindings`, treating the fence as binding nothing — so every
  capitalized tag in that file, including a genuinely imported one,
  misreported "Unable to find entry point for custom tag" instead of the
  real syntax error. `lowerAstroMx` now surfaces the fence's own parse
  error (`AstroTemplateError`, positioned at the actual broken line/column
  in the file) when `sourceBindings` reports one, instead of silently
  falling through to component resolution with no bindings. No downstream
  layer had reported it yet at that point — `lowerAstroMx` never runs
  Astro's own compiler itself, so there is no risk of a duplicate
  diagnostic for the same error.
- `rejectUnknownTag`'s Marko-wording message now comes from `@mxlang/core`'s
  `unresolvedCustomTagMessage` instead of a hand-copied literal. No
  behavior change.

### Changed

- **Behavior change (local extension of decision 116, firstmate's ruling):**
  a `---` fence binding used as a tag now classifies the same way `.solid.mx`
  does — `@mxlang/parser`'s new `unknownSourceBindings` marks a non-import
  `const`/`function`/`class` whose value isn't statically a function/arrow/
  class as "unknown". A function-like fence binding (the common case) is
  entirely unaffected. Astro has no dynamic-tag construct at all (unlike
  every other host, `component()`'s own pre-existing guard rejects any
  non-`"name"` target unconditionally), so an unknown binding now fails at
  MX compile time with its own named error — `` `<Tag>` is bound in the
  frontmatter to a value MX can't prove is a component, and @mxlang/astro
  can't render a tag name decided at runtime. `` — instead of the
  pre-existing silent misroute (a literal `<Tag>` JSX reference that failed
  only at Astro's own render time with an opaque `NoMatchingRenderer`-class
  error).

- Named slots now expose both the callable renderable view and the default
  data view's `.content` thunk to `.mx` components. Arrays, attributes,
  params, and nested attribute tags remain positioned host errors because an
  Astro slot is keyed only by name. Nested conditionals and empty branches now
  emit valid Astro expressions, and bodiless tags are rejected because they
  have no markup to project.
- **Behavior change (decision 114 parity, `unresolved-tag-jsx-astro-angular`):**
  `<TotallyUndefined/>` — a capitalized tag with no `---` fence import,
  binding, or taglib entry — now fails to compile with Marko's own error
  ("Unable to find entry point for custom tag `<TotallyUndefined>`."),
  matching `@mxlang/html` and `@mxlang/solid`. `isComponent` used to be a
  bare `/^[A-Z]/` casing test, so every capitalized `.amx` tag resolved as a
  component whether or not the fence actually imported it. `lowerAstroMx`
  now parses the fence's own top-level value bindings
  (`@mxlang/parser`'s `sourceBindings`, new dependency) into `ctx.imports`
  before lowering — the same operator-ruling extension decision 114 already
  gave `.solid.mx`'s surrounding module — so a fence `import Card from
  "./Card.astro"` still resolves `<Card/>` exactly as before; only a
  genuinely undeclared capitalized tag now errors instead of silently
  compiling. A type-only fence import does not resolve a tag either
  (decision 114/115). `<Fragment>` — the one Astro built-in the real
  compiler auto-imports (`@astrojs/compiler-rs`, astro@7.3.2; measured, the
  only such name) — resolves with no fence import needed.
