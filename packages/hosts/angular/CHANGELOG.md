# Changelog

## Unreleased

### Added

- Attribute-tag IR v2 support for singular `ngProjectAs` projections,
  including mutually exclusive `<if>`/`<else if>`/`<else>` branches and the
  Angular `AttrTag<C>` projection marker with automatic type imports.

### Changed

- Projected `AttrTag` properties are no longer emitted as `@Input()` class
  fields, even when unused: Angular supplies projected nodes through
  `<ng-content>`, not as values. Direct calls, `.content()` calls, dynamic
  `.content` tags, renderable dynamic tags, and their optional-chain forms
  lower to that projection; all other value reads are positioned errors.
  Arrays, attributes, params, nested tags, and bodiless tags remain positioned
  host errors.
