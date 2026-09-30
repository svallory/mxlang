# Changelog

## Unreleased

### Added

- **A `standalone: false` `.ng.mx` component no longer gets an injected
  `imports:`.** Angular rejects `imports` on a non-standalone component, so
  `compileNgMx` now leaves such a decorator alone (and skips the matching
  `@angular/common` / tag `import` statements) and instead emits a positioned
  warning naming each symbol, with its module, that the declaring NgModule
  must provide (`NgClass` from `@angular/common`, a called MX tag component
  from its emitted module). `standalone: true` or an absent flag behaves as
  before. The warning names the component class and literal selector; a
  quoted key and `as const` / `satisfies` / `!` around the literal are
  recognised, and any other non-literal `standalone` value keeps the
  standalone behaviour but warns (positioned) that it cannot be determined.

- Attribute-tag IR v2 support for singular `ngProjectAs` projections,
  including mutually exclusive `<if>`/`<else if>`/`<else>` branches and the
  Angular `AttrTag<C>` projection marker with automatic type imports.

### Changed

- **An unresolved capitalized tag is a compile error, matching Marko
  6.3.51** (decision 114, extended to Angular): `<TotallyUndefined/>` — no
  import, `<define>`, local binding, or taglib entry — now fails with
  Marko's own "Unable to find entry point for custom tag
  `<TotallyUndefined>`.", routed through the same core `rejectUnknownTag`
  check every other Marko-parity host uses. Previously it emitted
  `<mx-totally-undefined>` plus the step-1 import warning, presenting a tag
  nothing resolves as one import away from working. `isComponent` now
  routes a capitalized tag only when a file-local binding or a non-element
  taglib entry resolves it; the step-1 used-tag import warning is unchanged
  for resolved tags. A capitalized tag bound to a value import that is not a
  `.mx` default import, or to a local whose value cannot be statically
  proven (a `<for>` tag param), lowers dynamically (decision 116) and emits
  `ngComponentOutlet`, the same lowering an authored `<${expr}/>` already
  had.
- Projected `AttrTag` properties are no longer emitted as `@Input()` class
  fields, even when unused: Angular supplies projected nodes through
  `<ng-content>`, not as values. Direct calls, `.content()` calls, dynamic
  `.content` tags, renderable dynamic tags, and their optional-chain forms
  lower to that projection; all other value reads are positioned errors.
  Arrays, attributes, params, nested tags, and bodiless tags remain positioned
  host errors.
