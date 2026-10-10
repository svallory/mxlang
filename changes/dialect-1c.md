---
packages: [tsc, typescript-plugin, language-server, vite-plugin, target-registry]
kind: Added
---

The tools check a dialect's files. `mx-tsc`, the language server and the TypeScript plugin route a file to the dialect that claims its extension (`mx.extensions` can route more, and `.probe.mx`-style extensions count), run `lowerSource` on it under the dialect's own syntax and tag rules, and report its diagnostics. A diagnostic's `source` is the dialect's `name` (`mxlang` for a file whose extension a project hands to dialects but routing cannot settle) and its `code` is the dialect's own code; `mx-tsc` prints that code where `tsc` prints `TS<number>`, as in `page.probe(1,4): error PROBE_BAD: bad probe`. No JavaScript is generated for these files, and a file that is not a dialect's is checked exactly as before.

The Vite plugin refuses to import a dialect's file: building a file calls its dialect's emit, and the error is positioned at the head of the file, `<dialect name> files cannot be imported: the dialect registers no emit`. A dialect file that does not check clean reports its first error instead, at its own position.

`mx.target: "tree"` is now the ordinary unknown-target error in every tool, listing the valid targets. The `mx-tsc` data-package check and the registry's data-target mask are gone with the target they served.
