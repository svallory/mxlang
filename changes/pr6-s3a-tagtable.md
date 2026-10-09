---
packages: [core, html, preact, angular, solid, astro, data, typescript-plugin]
kind: Changed
---

A compile no longer builds `@marko/compiler`'s taglib lookup (decision 197, PR 6 slice S3a): core's own tag table, the target's taglibs over its `nativeTags`, gives the MX front end each tag's shape and tells lowering an element from a tag. It reproduces the lookup's merge for every translator MX builds, pinned against the live lookup (`tag-table.test.ts`). `@mxlang/preact`, `@mxlang/angular`, `@mxlang/solid`, `@mxlang/astro` and `@mxlang/data` now depend on `@mxlang/web-elements` and pass its table as their `nativeTags`, and `@mxlang/data` derives its neutralized parse rules from it (the same 19 names). A `.<host>.mx` region reads the same table, so `<param>` is a native element in a region as it already was in a whole file. The `typescript-plugin` mapping pass builds core's table instead of Marko's lookup. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged.
