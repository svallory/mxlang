---
packages: [core]
kind: Added
---

A contract hook's `ctx.fail` takes a code: `ctx.fail(message, { at?, code? })` in `analyze` and `transform`, the same shape as a trigger's and an `afterLower`'s. `code` travels as `TranslateError.diagnosticCode` to `IrDiagnostic.code`, so a module no longer has to put its code in the message text. A bare position as the second argument still works. An empty `code`, a malformed `at`, or an unknown option is a positioned error. New type `ContractFailOptions` (`@unstable`).
