---
packages: [angular, hono, preact, react]
kind: Changed
---

A `$ let` or `$ var` scriptlet on the React, Preact, Hono and Angular hosts now ends with the fix, as the `$ const` and non-declaring scriptlet errors already did. These hosts have no mutable `<let>` form, so the message names where the statement goes instead of stopping at the rule. The code and the position (the `$` line, column 0) are unchanged.

| Where it surfaces | Old text | New text |
| --- | --- | --- |
| `$ let x = 1;` or `$ var x = 1;` in a `.react.mx`, `.preact.mx` or `.hono.mx` file | `` scriptlets (`$ statement`) are not supported in MX `` | `` scriptlets (`$ statement`) are not supported in MX; move the statement out of the template `` |
| the same inside a region of a `.react.mx`, `.preact.mx` or `.hono.mx` module | `` scriptlets (`$ statement`) are not supported in MX `` | `` scriptlets (`$ statement`) are not supported in MX; declare it in the surrounding component `` |
| `$ let x = 1;` or `$ var x = 1;` in an Angular `.mx` file | `` scriptlets (`$ statement`) are not supported in MX `` | `` scriptlets (`$ statement`) are not supported in MX; declare it in the component class `` |
| a `$ let x = ;` or `$ var x = ;` line that does not parse, on the same hosts | `` Unexpected token; scriptlets (`$ …`) are not supported `` | the same text followed by the fix from the matching row above |

The `$ const` replacement (`<const/x=…/>`) and the Solid and Astro texts are unchanged. A golden file or a test that pins one of the old texts needs to be regenerated.
