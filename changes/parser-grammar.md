---
packages: [core]
kind: Fixed
---

An `import` or `export` below the top level of an attribute value, placeholder, argument list, parameter list, pattern or statement payload (a `static`, `server` or `client` statement, or a scriptlet) is now a positioned `MX_INVALID_STATEMENT` diagnostic, with or without a dialect trigger in the expression, instead of `internal error: Cannot read properties of undefined (reading 'has')`.
