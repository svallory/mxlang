---
packages: [core]
kind: Changed
---

**BREAKING (decisions 202 and 212): a syntax module is now a dialect, and a file reaches its dialect by its extension.**

- **A dialect is a package.** It declares itself in its own `package.json`, under `mx.dialect`: `{ "id", "name", "extensions", "module" }`. `mx.dialect` is an identity block, never project configuration: the project's own `mx` settings are read as if it were not there.
  - `id` is lower-case words joined by `-`, never `mx`. It keys the dialect's node types and the project's `mx.extensions`.
  - `name` is the name tooling shows the dialect's users.
  - `extensions` lists the file extensions the dialect claims, each with its leading dot. `.mx` is always MX's.
  - `module` is a path, relative to that `package.json`, to the module whose default export is the dialect. It must stay inside the package: an absolute path, or one that climbs out with `..`, is an error.
  - A malformed manifest is a positioned error at the field, in the dialect's `package.json`.
- **Discovery reads only the project's direct dependencies.** The project is a file's nearest `package.json`. Core reads its `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies`, finds each package where Node would, and keeps the ones that declare `mx.dialect`. It never scans `node_modules`. A dialect package routes its own files too. A dialect's module loads only when a file it claims is compiled. Discovery follows the dependencies on disk: an install, an upgrade or an edited dependency `mx.dialect` is seen at the next compile.
  - Two dialects with one `id` is an error at the second one's dependency entry, naming both: `` two dialects have the id `mesh`: mesh-a and mesh-b. A dialect's id is its identity; keep one of these dependencies ``.
  - A package listed under an alias (`"b": "npm:@real/b@1"`) is positioned at its key and named `` @real/b, as `b` ``.
- **Routing.** A file goes to the dialect that claims the longest extension its name ends with. Every other file parses with MX's default row, as before.
  - Two dialects claiming one extension is an error at the second one's dependency entry, naming both: `` two dialects claim `.x`: `a` (a-dialect) and `b` (b-dialect). Choose one in `package.json#mx.extensions`: `"extensions": { ".x": "a" }` ``.
  - `package.json#mx.extensions` (`{ ".x": "<dialect id>" }`) settles a clash, or routes an extension to a dialect the project uses. A value that is not an object is an error at `mx.extensions`; a malformed entry is an error at its own key.
- **The dialect's identity comes from its manifest.** Core stamps the manifest's `id` and `name` on the loaded dialect. A module that states either must match the manifest. A module that does not resolve is an error at `mx.dialect.module`. A problem with the module's own shape or table is an error in the module file at 1:0, as before. A module that fails to load keeps reporting its own error until the file changes, on every supported Node (before 22.20, Node cannot `require` an ES module again once its evaluation threw). An edited dialect module is reloaded on Bun, and on Node for a CommonJS module; Node keeps an ES module it has loaded, so an edited `.mjs` or `.ts` dialect is picked up after a restart, as for `mx.contracts` modules.
- **`Dialect.productName` is removed.** Diagnostics on a dialect's files use the dialect's `name` where core's wording says "MX". The `productName` compile option still wins. A file no dialect claims says `MX`.
- **`Dialect.tagRules` defaults to `html`.** A dialect that states no preset gets `html`, not `none`. `lowerSource` reads it: a call with no `tagRules` option parses under the `dialect` option's preset, else the routed dialect's.
- **The explicit option is renamed from `syntax` to `dialect`.** This applies to `compileSource` (`HostOptions.dialect`), `parseFragment` and `lowerSource` (`LowerSourceOptions.dialect`). It takes a `Dialect` or a bare `SyntaxTable`. A `Dialect` passed this way must carry `id` and `name`. Its messages change:
  - `` the `syntax` option must be a syntax table object, not null; omit it to use the file's `package.json#mx.syntax` `` becomes `` the `dialect` option must be a dialect or a syntax table object, not null; omit it to use the dialect that claims the file's extension ``.
  - `` the `syntax` option is not a valid syntax table: `syntax.<field>` … `` becomes `` the `dialect` option is not a valid syntax table: `dialect.<field>` … ``.
  - `` the `syntax` option is not a valid syntax module: `` becomes `` the `dialect` option is not a valid dialect: ``.
- Wording follows the rename. `` the syntax module's `afterLower` `` and `` `checkContract` `` become `` the dialect's … ``. `` … and the module exports no `lowerTrigger` `` becomes `` … and the dialect exports no `lowerTrigger` ``, in the dialect's module at 1:0.
- The reference modules `@mxlang/core/syntax/{member,atoms-sugars,mesh}` are dialects. Their ids are `member`, `atoms-sugars` and `mesh`. Their names are `Mesh`, `MX` and `Mesh`.
