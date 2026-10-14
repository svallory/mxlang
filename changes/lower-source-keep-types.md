---
packages: [core]
kind: Added
---
`lowerSource` takes `stripTypes?: boolean`. The default (`true`) is unchanged: TypeScript is erased before lowering, so the nodes a dialect's hooks see carry no annotations and a top-level `as`, `!` or `satisfies` is reduced to its operand. `stripTypes: false` keeps the authored TypeScript in the nodes (`TSTypeAnnotation`, `returnType`, `TSAsExpression`, …) and in `Expr.code`, for a dialect whose `nodeType.lower`, contract hooks or `afterLower` read types. A tag-file hook's `ctx.lower` takes the option too, and its memo is keyed on it. The IR shape is the same either way.
