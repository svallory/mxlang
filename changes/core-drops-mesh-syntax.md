---
packages: [core]
kind: Removed
---

**Breaking:** `@mxlang/core` ships no dialect. The `@mxlang/core/syntax/mesh`, `@mxlang/core/syntax/atoms-sugars` and `@mxlang/core/syntax/member` exports are gone: a dialect owns its rows, and Mesh's atoms, name sugars and `&` members live in Mesh. Core keeps the generic hook API they were built on (`Dialect`, `Trigger`, `NodeType`, `LoweredUnit` and the `lowerTrigger` context), and its tests of the claim process now run on test-local fixture dialects. A package that imported one of the three subpaths copies the rows into its own dialect, importing its types from `@mxlang/core`.
