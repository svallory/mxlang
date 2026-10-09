---
packages: [core, html, preact, react, hono, angular]
kind: Removed
---

A `marko.json` (or `marko-tag.json`) taglib is no longer read (decision 197, PR 6 slice S3a). A tag only a `marko.json` maps (`template`, `renderer`, `tags-dir`) is an unknown tag like any other: `@mxlang/html`'s "Unable to find entry point for custom tag" error, the native element on Preact, React, Hono and Angular. It was imported and called before. With it go `@mxlang/html`'s and `@mxlang/preact`'s `resolveDiscoveredTagModule` implementations; the optional hook stays on `HostDeclarations` for a third-party target. A `tags/x.marko` file is still the decision 172 error, now found by core's own discovery on every host. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged.
