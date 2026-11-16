---
packages: [angular, astro, vite-plugin]
kind: Changed
---

Passing `.marko` in `extensions` to `mxAstro()` or `mx()` now throws `'.marko' is not a supported extension in 'extensions'; MX templates use the '.mx' extension.` (prefixed with `@mxlang/host-astro:` or `@mxlang/vite-plugin:`). The Angular warning for a literal `@defer`, `@placeholder`, `@loading`, `@error` or `@empty` block now reads `` `@defer (on idle)…` is literal text in an MX template; there is no equivalent tag for this Angular block. Use `${"@"}defer` for literal text. ``
