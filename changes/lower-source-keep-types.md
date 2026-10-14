---
packages: [core]
kind: Added
---
`lowerSource` takes `stripTypes?: boolean`. The default (`true`) is unchanged: TypeScript is erased from the nodes before lowering, so a top-level `as`, `!`, `satisfies` or `<T>x` is replaced by its operand, and annotations are gone from the nodes (`Expr.code` is sliced from the source either way). `stripTypes: false` keeps the authored TypeScript in the nodes a dialect's `nodeType.lower`, contract hooks and `afterLower` see (`TSTypeAnnotation`, `returnType`, `TSAsExpression`, …). With `false`, core's own checks see the assertion too: a bound attribute over one is `MX_INVALID_BOUND_ATTRIBUTE`, and an attribute whose value is an assertion over a literal is `dynamic` rather than `static`. A tag-file hook's `ctx.lower` takes the option but does not inherit the outer call's value, and its memo is keyed on it.
