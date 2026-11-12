---
packages: [core]
kind: Fixed
---

A dialect's post-hook refusal of a trigger's `:=` value or `(args)` that nothing can place now points at the operator, not the value. A hook that builds a second `ctx.expression` value for the same trigger text is a positioned error instead of getting both splices applied to each value's code.
