---
packages: [core, target-registry, language-server]
kind: Fixed
---

Editing a file a dialect's `tagFile` hook names with `ctx.dependsOn` re-checks the dialect files that call that tag file. `checkDialectFile` now adds those files, and the files of the tag files the hook's tag files called, to the dependencies it reports (new `tagFileDependencies` export of `@mxlang/core`, `@unstable`), and the language server asks the client to watch a dependency no watcher glob names (a `.json` data file) by its own path. Before, only the tag files, contracts modules, sidecars and configs the scan read were dependencies, so the file changed on disk and the dialect file kept its old diagnostics until it was edited.
