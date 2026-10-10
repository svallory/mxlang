---
packages: [core]
kind: Changed
---

`@mxlang/core` loads its heavy dependencies lazily: importing the package no longer loads `@babel/parser` (it now loads on the first parse), `@babel/plugin-transform-typescript` (on the first TypeScript strip) or `cosmiconfig` (on the first MX config read; `MX_CONFIG_SEARCH_PLACES` now spells out cosmiconfig 10.0.1's defaults, pinned by a test). Importing `@mxlang/core` in a fresh process is ~10 ms faster on Node and Bun; the first `lowerSource` cost is unchanged, as it is dominated by the `@babel/core` traverse/types graph that lowering itself requires.
