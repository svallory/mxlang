---
packages: [core, target-registry, solid, preact, astro, angular, html, vite-plugin, typescript-plugin, language-server, tsc]
kind: Fixed
---

File-kind suffix checks follow one rule everywhere, the lower-cased name ends with the suffix: `Counter.Solid.MX`, `Card.MX` and `tag.MARKO` are now the same file kind in the build, the Bun loader, the editor plugin, the language server and the Angular host as their lower-case names. A failed compile of a Preact/React/Hono region, an `.astro.mx` template or an `.ng.mx` file, and a Solid error thrown after lowering, now carries `dependencies` naming the callees it read, so a watcher can rebuild when the callee is fixed; core exports `attachDependencies` and `lowerKeepingDependencies` for this, and `AstroTemplateError` gains `dependencies`. tsconfig `paths` aliases now reach `.mx` callee imports in region files, `.astro.mx` and `.ng.mx` callers in the TypeScript plugin and `mx-tsc` (a new optional `resolveImport` on `HostRegionInput`, `RegionCompileOptions` and each host's region, Astro and Angular entry). `mx-tsc --astro` loads the project's own `@astrojs/language-server` before its bundled copy.
