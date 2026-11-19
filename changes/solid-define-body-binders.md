---
packages: [core, solid]
kind: Added
---
The params Solid writes as plain text are mapped to their authored text as declarations: a `<for>`'s params, a call's content params (`<Box|v|>`), an attribute tag's params (`<@item|v|>`, `<@catch|err|>`) and an attribute-tag `<for>`'s params. Inside a `.solid.mx` region's `<define>` body, go-to-definition and rename from a read of such a param now reach the param, where before they reached nothing or only the read. The mappings serve navigation and hover only, so no new diagnostic appears at a param. An element `<for>` with `step` and an element `<for in=>` write no binder, so their params stay unmapped. The IR's `Block` gains an optional `paramSpans` (one span per param, filled for authored blocks), and `IR_VERSION` is 21. The emitted code is unchanged.
