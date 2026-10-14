---
packages: [html, typescript-plugin, tsc]
kind: Fixed
---
On the html target, `mx-tsc` and the editor now report a type error inside a `server` or `client` statement at the token you wrote, where `server` errors were reported at 1:1 as "an MX bug" and `client` statements were not type-checked at all. A `client` statement's own code is now part of the type-check projection, so a `client let`, `client function` or `client const` read in the template has its declared type (no more TS7005/TS7034 under `strict`; a `client var q;` with no initializer is `any` in TypeScript too and is reported at `q`). The compiled page is unchanged: a `client` statement still leaves only `var <names>;`.
