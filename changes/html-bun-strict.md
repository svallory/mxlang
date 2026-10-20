---
packages: [html]
kind: Changed
---

The Bun loader compiles under the resolved strictness: a target descriptor
declaring `strict: "always"` or `mx.strict: true` in the file's nearest
`package.json` now makes `@mxlang/target-html/bun` refuse the constructs the
strict policy rejects — reactive state (`<let>`), lifecycle hooks
(`<lifecycle>`), `<script>` as a tag and `client` blocks, and the debug-only
constructs (`<id>`, `<log>`, `<debug>`) — with the strict policy's error, the
same rule the editor tools and `vite build` already apply —
a Bun build no longer compiles what those tools flag. `<effect>` was already
refused; only its message is unchanged. A project that resolves
non-strict compiles byte-identically to before.
