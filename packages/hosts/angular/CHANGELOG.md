# Changelog

## Unreleased

### Added

- Attribute-tag IR v2 support for singular `ngProjectAs` projections,
  including mutually exclusive `<if>`/`<else if>`/`<else>` branches and the
  Angular `AttrTag<C>` projection marker with automatic type imports.

### Changed

- Projected `AttrTag` properties are no longer emitted as `@Input()` class
  fields: Angular supplies projected nodes through `<ng-content>`, not as
  values. Arrays, attributes, params, and nested attribute tags remain
  positioned host errors.
