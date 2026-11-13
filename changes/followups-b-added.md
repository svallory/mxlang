---
packages: [tsx-bridge, angular]
kind: Added
---

`sourceBindings` returns the source's value imports as a new `imports` field (`SourceImports`: each local's specifier, the default imports from a `.marko`/`.mx` file, and where each import statement starts; empty on a parse failure). `compileNgMx`'s result has a `dependencies` field: the callee files core read across every region, each once, in first-seen order.
