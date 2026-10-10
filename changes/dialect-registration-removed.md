---
packages: [core]
kind: Removed
---

**BREAKING (decisions 202 and 212; decision 195, no aliases):**

- The `SyntaxModule` type is removed; use `Dialect`.
- `normalizeMxSyntax` is removed.
- `package.json#mx.syntax` is removed in both forms, an inline table and a module string. No setting selects a file's syntax any more: a dialect package claims extensions instead. Either form is now a positioned error at its key: ``` `mx.syntax` is removed: a syntax of your own is a dialect, a package that declares itself in its `package.json#mxDialect` (`id`, `name`, the `extensions` it claims, its `module`) and is one of the project's dependencies; a file goes to the dialect that claims its extension. `.mx` files are always MX's. ```
