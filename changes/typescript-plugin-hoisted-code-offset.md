---
packages: [typescript-plugin]
kind: Fixed
---
In a whole-file `.mx` page, a diagnostic on a `static` statement is reported after the keyword. The plugin located the statement's code by searching from the start of the statement, so `static a` mapped `a` onto the `a` inside `static` itself (and `static s`, `static t`, `static i`, `static c` onto the matching letter of the keyword), putting the diagnostic and hover two to five characters into the keyword. The search now starts after `static` and the whitespace that follows it, so the block form `static { let a = 1 }` also maps to its statements. A Solid page records its statement mappings in `@mxlang/host-solid` and is not changed by this.
