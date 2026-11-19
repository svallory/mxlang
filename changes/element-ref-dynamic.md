---
packages: [core, html, preact, react, solid]
kind: Changed
---
An identifier tag variable on a string-literal dynamic tag that names no native element (`<${"my-el"}/el/>`, `<${"Foo"}/el/>`) is now an element reference, as stock Marko binds it: `el()` is the rendered element, with the same rules as `<div/el>`. On html, Preact and React it bound the dynamic tag's value before (on Preact and React that was `undefined` for a string target); a write to it is now refused (`MX_READONLY_BINDING_WRITE`) and a read outside a handler or `<script>` body is refused (`MX_INVALID_TAG_VAR`). On Solid it compiles where it was refused. html binds the same throwing getter as for `<div/el>`, Preact and React pass the element reference's callback as the `ref` of the dynamic tag's props, composed with an authored `ref=`, and Solid writes it on `<Dynamic>`. The IR gains an optional `elementRef: true` on `Component` and `DelegatedTag` (`IR_VERSION` 19). Hono, Angular and Astro are unchanged.
