---
packages: [html]
kind: Fixed
---

The default `@mxlang/target-html/bun` loader now compiles an astro project strict under every way of selecting it (`mx.host: "astro"`, `mx.target: "astro-html"`, or a lone `@mxlang/host-astro` dependency), as the editor tools and `vite build` do. Its own lookup registers only html, so these selections used to resolve as unknown or ignored and the project compiled non-strict under Bun. Strictness now resolves through stand-ins for the other built-in targets, so the loader agrees with the registry for dependency counts and host words too.
