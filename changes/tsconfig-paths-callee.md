---
packages: [typescript-plugin, tsc]
kind: Fixed
---

Honour tsconfig `paths` and `baseUrl` when the TypeScript plugin and `mx-tsc`
resolve callee imports from whole-file `.mx` callers. Region, `.astro.mx`, and
`.ng.mx` callers are not included. A project that mirrors its Vite `resolve.alias`
in tsconfig `paths` (for example `import Card from "~/Card.mx"`) no longer
reports a false `MX_UNREADABLE_CALLEE_INPUT` in the editor or `mx-tsc` while
`vite build` resolves the import. The editor also retries unresolved exact and
extension-omitted aliases through Volar to avoid a false `TS2307`; `mx-tsc`
already has that import-resolution fallback. Callee `Input` reads use the
program's own compiler options and resolve afresh on each lookup, so a caller
edit sees newly created or moved callees even when those options do not change.
The language server has no ts program and still reports the alias as unresolved.

`MxLanguagePluginOptions` gains an optional synchronous `resolveImport` callback
for whole-file callee reads. The package also ships the resolver's supporting
`tsconfig-paths.d.ts` declaration without adding a package-entry export.
