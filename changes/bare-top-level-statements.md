---
packages: [core]
kind: Fixed
---
A `static` alone on its line is accepted and declares nothing, as in Marko (it was refused with "Unexpected reserved word 'static'"). A top-level `export` of `default` with no `static`, `server` or `client` before it (`export default function f() {}`, `export default <value>`, `export { x as default }`, `export { default } from "…"`, `export * as default from "…"`, type-only forms included) is now a positioned `MX_INVALID_STATEMENT` error over the export, with the rule and the fix, as in Marko. It compiled before, and the module then failed to load because it exported `default` twice.
