---
packages: [html]
kind: Fixed
---

The default `@mxlang/target-html/bun` loader now compiles a project with `mx.host: "astro"` strict, as the editor tools and `vite build` do. Its own lookup does not register the astro host, so the host used to resolve as an unknown word and the project compiled non-strict under Bun.
