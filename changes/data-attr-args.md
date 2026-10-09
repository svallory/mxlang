---
packages: [core, data]
kind: Added
---

- data: the tree keeps an attribute's arguments. `DataAttr` variants other
  than the spread gain `args?: DataExpr[]`, built like `DataTag.args`: `x a(b)`
  is a boolean `a` with `args: [b]`, `x a(b, c)` has two, `x a(&b)` carries the
  member the syntax module built, and `x a()` carries `args: []`. The field is
  present only when the parentheses were written. Before this, `a(b)` read as
  a bare `a` and `a(&b)` lost its member. The method shorthand
  (`isOverdue() { … }`) is unchanged: it stays a function-expression `value`
  and never routes through `args`. The `parseData` option shape is unchanged.
- core: the IR `Attr` (every kind but `spread`) carries `args?: Expr[]` for an
  attribute written with arguments, so a target can read them; no existing
  host emits them.
