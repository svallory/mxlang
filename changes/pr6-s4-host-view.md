---
packages: [core]
kind: Changed
---

Internal groundwork for the hook view of decision 197 (PR 6 slice S4): core builds the plain-data `HostTagView` (with an opaque `MxNodeHandle`) and attribute entries from the MX AST, and `rejectUnsupportedFields` and `wildcardMatchOf` accept a view or its handle. Nothing is exported yet and no hook receives it yet; no diagnostic text or position changes. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).
