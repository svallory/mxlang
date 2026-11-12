---
packages: [core]
kind: Fixed
---

Module statements now follow stock Marko 6.4.x where it refuses or accepts them. A `client` block may use `super` and `new.target`. A plain enum in a `static` or `server` statement, an exported enum declared again in a later statement or after a namespace with values, an `import x = …` alias beside another declaration of its name (in a block or a function) or a `var` after one, and an export list inside a namespace are refused with a coded, positioned diagnostic instead of a raw internal error or an unloadable module. A namespace inside a function or block is refused at the namespace (`MX_INVALID_STATEMENT`, move it to the top level) instead of getting advice to reorder it, and a `$` scriptlet holding a namespace or enum reports the scriptlet refusal first.
