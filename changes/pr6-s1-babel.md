---
packages: [core, html, angular, typescript-plugin]
kind: Changed
---

Core lowers, prints and strips TypeScript with stock Babel instead of `@marko/compiler`'s bundled copy (decision 197, PR 6 slice S1). `@babel/parser`, `@babel/core` (its `traverse`, `types` and `File`), `@babel/generator`, `@babel/code-frame` and `@babel/plugin-transform-typescript` are exact-pinned runtime dependencies of `@mxlang/core`, external to its bundle and loaded lazily; no published `.d.ts` names a `@babel/*` type. The `CompileError` text is byte-identical (the kleur colour rule and `cwd` are ported), and the stock generator prints every payload of the repo's `.mx` corpus as Marko's did (`babel.test.ts`). `@mxlang/html` and `@mxlang/angular` parse their modules and expressions with `@babel/parser` directly (a new dependency of each); `@mxlang/typescript-plugin`, whose dist inlines the Angular host, keeps `@babel/parser` external and declares it, so its bundles carry no second parser. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).
