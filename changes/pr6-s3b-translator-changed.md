---
packages: [core]
kind: Changed
---

The lowering context's tag table is `Ctx.tagTable`, renamed from `Ctx.lookup` (decision 197, PR 6 slice S3b), along with `newCtx`'s matching parameter and `WildcardContext`'s picked field. It has been core's own tag table since slice S3a; the old name described the Marko lookup S3b deleted. A host or tool that reads or sets `ctx.lookup` must use `ctx.tagTable`. `parseMx`'s `lookup` option keeps its name. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).
