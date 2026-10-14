---
packages: [core]
kind: Fixed
---
`export = value` and `import x = require("m")` (also `import type x = require("m")` and `export import x = require("m")`) anywhere in a `static`, `server`, `client` or `export` statement (in a block or without one, inside an `if`, a function or a class method), except directly in a namespace or `declare module` body, are a compile error at the form, `MX_INVALID_STATEMENT`, with a message that says the form is only supported when compiling modules to CommonJS and what to write instead (a named export, an ES `import`, or for `export import` a re-export). They stopped the compile with Babel's CommonJS error, no code and a position in the generated code (189:16). `import x = M.N`, a TypeScript alias, still compiles.
