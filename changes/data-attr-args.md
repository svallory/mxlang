---
packages: [core]
kind: Added
---

- core: the IR `Attr` (every kind but `spread`) carries `args?: Expr[]` for an
  attribute written with arguments, so a target can read them; no existing
  host emits them. `x a(b)` is a boolean `a` with `args: [b]`, `x a(b, c)` has
  two, `x a(&b)` carries the member the syntax module built, and `x a()`
  carries `args: []`. The field is present only when the parentheses were
  written. The method shorthand (`isOverdue() { … }`) is unchanged: it stays a
  function-expression `value` and never routes through `args`.
