---
packages: [core]
kind: Fixed
---
`export = value` and `import x = require("m")` (also `import type x = require("m")` and `export import x = require("m")`) in a `static`, `server`, `client` or `export` statement, in a block or without one, are a compile error at the statement, `MX_INVALID_STATEMENT`, with a message that says the form is only supported when compiling modules to CommonJS and what to write instead (a named export, or an ES `import`). They stopped the compile with Babel's CommonJS error, no code and a position in the generated code (189:16). `import x = M.N`, a TypeScript alias, still compiles.
