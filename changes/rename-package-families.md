---
packages: [html, target-registry, react, preact, solid, hono, astro, angular]
kind: Changed
---

Renamed (decision 201, package families): `@mxlang/html` -> `@mxlang/target-html`;
`@mxlang/target-registry` -> `@mxlang/targets`, now the umbrella (the registry,
the html target's descriptor as `htmlTarget`, and the html target's full entry
at `@mxlang/targets/html`); `@mxlang/react` -> `@mxlang/host-react`;
`@mxlang/preact` -> `@mxlang/host-preact`; `@mxlang/solid` -> `@mxlang/host-solid`;
`@mxlang/hono` -> `@mxlang/host-hono`; `@mxlang/astro` -> `@mxlang/host-astro`;
`@mxlang/angular` -> `@mxlang/host-angular`. Imports, emitted runtime imports
(`@mxlang/host-solid/...`) and `mx.target` package selection use the new names.
The old names are deprecated on the registry at the next publish.
`@mxlang/data` is not renamed: the tree-ir-entry change deletes it (decision 204).
