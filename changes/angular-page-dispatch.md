---
packages: [typescript-plugin, vite-plugin, angular]
kind: Fixed
---
Angular page `.mx` files no longer produce a false "host not wired" error or a virtual module in the TypeScript plugin. Pages compile to Angular template strings, not modules; the Vite plugin refuses their import with guidance to run `mx-angular build` before `ng build`, or `mx-angular watch` next to `ng serve`. The language server continues to report real MX compile diagnostics for those pages.
