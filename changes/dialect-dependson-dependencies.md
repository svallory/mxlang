---
packages: [core, target-registry, language-server]
kind: Fixed
---

Editing a file a dialect's `tagFile` hook names with `ctx.dependsOn` re-checks the dialect files that call that tag file. `checkDialectFile` now adds those files, and the files of the tag files they called, to the dependencies it reports, counting only the tag files this check's lowering read (new `collectTagFileDependencies` export of `@mxlang/core`, `@unstable`). The language server asks the client to watch a dependency no watcher glob names (a `.json` data file) by its own path, and stops watching it once no open document names it. Before, only the tag files, contracts modules, sidecars and configs the scan read were dependencies, so the file changed on disk and the dialect file kept its old diagnostics until it was edited.
