---
packages: [core]
kind: Fixed
---

An `export` or `import` inside an arrow, function or block in an attribute value, placeholder, argument list or pattern is now a positioned `MX_INVALID_STATEMENT` diagnostic, with or without a dialect trigger in the expression, instead of `internal error: Cannot read properties of undefined (reading 'has')`.
