---
packages: [core, data]
kind: Added
---
`package.json#mx.syntax` (decision 182, PR C): core resolves a file's syntax table from its nearest manifest (a dependency's files use the dependency's manifest), overlaid on the `.mx` default row, validated with positioned diagnostics at the manifest's `mx.syntax` key (`tagTypes` is refused: tag types are taglib-owned), frozen and interned by hash. `compileSource`, `parseFragment` and `@mxlang/data`'s `parseData` accept an explicit `syntax`. Core lowers no trigger yet: a file whose table produces a trigger, block tag or filter fails with one positioned error ("`<id>` trigger has no lowering yet"), and a project on the default row runs no extra parse. New exports: `SyntaxTable`, `Trigger`, `StandIn`, `TriggerNode`, `SyntaxDiagnostic`, `defaultSyntax`, `normalizeMxSyntax`, `resolveSyntax`, `syntaxHash`.
