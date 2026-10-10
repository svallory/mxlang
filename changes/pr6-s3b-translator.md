---
packages: [core, html, preact]
kind: Removed
---

Marko's taglib lookup and its cache surface are gone from `@mxlang/core` (decision 197, PR 6 slice S3b). `buildMarkoLookup` and the `Lookup` type are no longer exported: core's own `tagTable(translator, nativeTags)` is the lookup, and its comparison with Marko 5.42.11's lookup is now a frozen fixture (`tag-table.expected.json`) instead of a live call, for the same six translator shapes and every name they hold. `evictTaglibCaches` is removed with the Marko half of the scan cache it cleared. `clearScanCache` and the per-map cache of loaded custom tags are unchanged. `Translator` no longer has a `tagDiscoveryDirs` field, so neither do `createTranslator`'s result or the `translator` objects `@mxlang/target-html` and `@mxlang/host-preact` export. Nothing read the field once `@marko/compiler` stopped running a compile; tags beside a file still reach a compile as `customTags`, found by the integration. `TranslatorOptions.tagDiscoveryDirs` is still accepted, but unread and `@deprecated`. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).
