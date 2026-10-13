---
packages: [typescript-plugin, solid]
kind: Fixed
---
In a whole-file `.mx` page, a diagnostic on a `static` statement is reported after the keyword. The statement's code was located by searching from the start of the statement, so `static a` mapped `a` onto the `a` inside `static` itself (and `static s`, `static t`, `static i`, `static c` onto the matching letter of the keyword), putting the diagnostic and hover two to five characters into the keyword. The search now starts after `static` and the whitespace that follows it, so the block form `static { let a = 1 }` also maps to its statements. The same fix applies to a Solid page, whose statement mappings `@mxlang/host-solid` records itself.
