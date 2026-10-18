---
packages: [core]
kind: Fixed
---
A dialect expression row written in a `static`, `server`, `client` or `export` statement is now a positioned `MX_INVALID_TRIGGER_USE` error at the row's first character. Before, the statement was hoisted as written, so a row such as `~zz` reached the module as JavaScript (a bitwise NOT) with no diagnostic, and a row that is not valid JavaScript (`&zz`) got Babel's "Unexpected token". The message names the trigger and says to move it into a `<const>` or write it in the template. The match is the template scanner's (a first character arms one row, the row's `match` must match in full); comments, strings and template-literal text are not scanned. A file with no dialect, a dialect whose rows do not appear in the statement, and a `structural: "reject"` file (which reports the structural error) are unchanged.
