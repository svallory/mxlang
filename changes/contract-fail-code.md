---
packages: [core]
kind: Added
---

A contract hook's `ctx.fail` takes a code: `ctx.fail(message, { at?, code? })` in `analyze` and `transform`, the same `{ at?, code? }` options as a trigger's and an `afterLower`'s, with `at` a `Position`. `code` travels as `TranslateError.diagnosticCode` to `IrDiagnostic.code`, so a module no longer has to put its code in the message text. A bare position as the second argument is the same as `{ at }`. An empty `code`, a malformed `at`, an unknown option, or a position that also carries `at` or `code` is a positioned error. New type `ContractFailOptions` (`@unstable`). A code survives a failure raised in a tag template's own tags.
