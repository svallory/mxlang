---
packages: [core, target-registry]
kind: Added
---
A dialect can rename the codes core reports on its files with `Dialect.diagnosticCodes`, an explicit map from a core code (`MX_UNKNOWN_TAG`) to the dialect's own (`KIT_UNKNOWN_TAG`). `lowerSource` applies it once to its final diagnostics, and the language server, the TypeScript plugin and `mx-tsc` report the renamed codes through `checkDialectFile`. Only the code changes. A code the map does not name keeps its `MX_` code, a dialect's own `ctx.fail` code is never renamed, and `MX_INTERNAL_ERROR` and `MX_DIALECT_HOOK_ERROR` cannot be keys. A map that is not an object, names a key that is not a core code, has a value that is empty or starts with `MX_`, fails the dialect at load.
