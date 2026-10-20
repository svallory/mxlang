---
packages: [core]
kind: Fixed
---

Refuse tag variables read in their own attributes, repeated declarations in one body (including declarations repeating that body's tag params), and reads of a `<define>` above its declaration. Plain-name `<const>` bindings are readonly inside their own initializer's functions too. Report an attribute-tag/body mix under control flow before a named-call argument error.

Compatibility note for dialect consumers, including Mesh: previously accepted source using these forms now receives positioned core diagnostics. The catalogue adds `MX_TAG_VAR_SELF_READ` and `MX_DEFINE_READ_BEFORE_DECLARATION`; Mesh must extend its exhaustive diagnostic-code map on upgrade, even though its static files refuse these constructs. No IR shape changes. Nested and sibling body shadowing, deferred function reads and a tag param named `input` remain accepted.
