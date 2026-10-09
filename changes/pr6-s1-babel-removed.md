---
packages: [core]
kind: Removed
---

`markoBabel()` and its type `MarkoBabel` are no longer exported from `@mxlang/core` (decision 197, PR 6 slice S1). A host that parses JavaScript depends on `@babel/parser` itself; printing stays `printExpression`.
