---
packages: [typescript-plugin]
kind: Added
---

A dialect diagnostic about another file (a tag file, the dialect's manifest) now carries `relatedInformation` in tsserver: one entry at that file's own range, with the message an editor shows there (without the ` (in <file>:<line>:<column>)` pointer). The diagnostic's own message, position and code are unchanged, and `mx-tsc` output is unchanged. `MxCompileDiagnostic` gains an optional `origin` (`@unstable`, the same shape as `DialectDiagnostic.origin`).
