---
packages: [core]
kind: Fixed
---

A dialect expression row written at a statement start in a `static`, `server`, `client` or `export` statement (after a block's `}`, as in `static { f(x) } ~zz`, or after a line break that ends a statement) is now refused with `MX_INVALID_TRIGGER_USE` at the row instead of reaching the module as JavaScript. Whether a mark is a row is now decided by Babel's TypeScript reading of the statement, with the row's stand-in in its place when the text as written does not parse: a private name, a type, an object key, a binding and a binary operator are never rows, and valid TypeScript is never refused.
