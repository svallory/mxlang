---
packages: [core]
kind: Added
---

`tagTable(translator, nativeTags)` and its types `TagTable`, `TagEntry`, `TagParseOptions`, `NativeTag`, `NativeTags` and `NativeBodyMode` (`@unstable`): core's own tag table, which a compile, `parseFragment` and `parseMxDocument` now read for each tag's parse shape and for element resolution (decision 197, PR 6 slice S3a). A target hands core its native elements through the new optional `HostDeclarations.nativeTags` (also `parseFragment`'s base field `nativeTags` and `parseMxDocument`'s fifth argument); every built-in target passes `@mxlang/web-elements`' `WEB_ELEMENTS`. A target without `nativeTags` gets no native parse rules (no void or raw-text elements). `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged.
