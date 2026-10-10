---
packages: [core, typescript-plugin, language-server]
kind: Changed
---

`@mxlang/core` loads its heavy dependencies lazily: importing the package no longer loads `@babel/parser` (it now loads on the first parse), `@babel/plugin-transform-typescript` (on the first strip, which every lowering with an expression payload runs) or `cosmiconfig` (on the first MX config read; `MX_CONFIG_SEARCH_PLACES` now spells out cosmiconfig 10.0.1's defaults, pinned by a test). Importing `@mxlang/core` in a fresh process is ~10 ms faster on Node and Bun.

A dialect's first `lowerSource` no longer loads `dist/marko-frontend.cjs`: validating a dialect's syntax table uses the template parser the dist already inlines (`@mxlang/parser` under its `./lexer` export, so core's type program still sees only the curated `public.d.ts`), which cut ~50 ms (forge, Bun) off a dialect's first call — the bulk of the regression Mesh reported. `@mxlang/typescript-plugin` and `@mxlang/language-server` declare `cosmiconfig` and list it (with `@babel/parser`) in `BUNDLED_INSTALLED`, so the VSIX bundles ship the requires the bundler cannot follow.
