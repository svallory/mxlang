---
packages: [core]
kind: Fixed
---

A dialect's post-hook refusal of a trigger's `:=` value or `(args)` that nothing can place now points at the operator, not the value. A hook that builds a second `ctx.expression` value for the same trigger text is a positioned error instead of getting both splices applied to each value's code. A dialect expression row written at a statement start in a `static`/`server`/`client`/`export` statement (after a block's `}`, or after a line break that ends a statement) is refused with `MX_INVALID_TRIGGER_USE`, like a row anywhere else in the statement.
