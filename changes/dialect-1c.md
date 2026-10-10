---
packages: [tsc, typescript-plugin, language-server, vite-plugin, target-registry]
kind: Added
---

The tools check a dialect's files. `mx-tsc`, the language server and the TypeScript plugin route a file to the dialect that claims its extension (`mx.extensions` can route more, and `.probe.mx`-style extensions count), run `lowerSource` on it under the dialect's own syntax and tag rules, and report its diagnostics. A diagnostic's `source` is the dialect's `name` (`mxlang` for a file whose extension a project hands to dialects but routing cannot settle) and its `code` is the dialect's own code; `mx-tsc` prints that code where `tsc` prints `TS<number>`, as in `page.probe(1,4): error PROBE_BAD: bad probe`. No JavaScript is generated for these files, and a file that is not a dialect's is checked exactly as before.

The Vite plugin refuses to import a dialect's file: building a file calls its dialect's emit, and the error is positioned at the import, `<dialect name> files cannot be imported: the dialect registers no emit`, with the same text whether or not the file checks clean. For an entry or a hand-built id, it is positioned at the head of the dialect file.

A dialect's file is checked against the project's contracts (`mx.contracts`) and local `tags/` like an MX file, so a contract violation shows in every tool. A dialect declared in a package below the project's root (a workspace package, or a `-b` reference of `mx-tsc`) counts for the files in that package, and a sibling package that declares no dialect keeps its own files. The language server no longer reports a package's `mx.target` problems on a dialect's file.

`mx.target: "tree"` is now the ordinary unknown-target error in every tool, listing the valid targets. The `mx-tsc` data-package check and the registry's data-target mask are gone with the target they served.
