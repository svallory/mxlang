# Changelog

## Unreleased

### Added

- Attribute-tag IR v2 support for singular named slots, including mutually
  exclusive `<if>`/`<else if>`/`<else>` branches, the Astro-specialized
  `AttrTag<C>` type, and its automatic `.amx` type import.

### Changed

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
