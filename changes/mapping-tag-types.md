---
packages: [core, typescript-plugin, tsc]
kind: Fixed
---

Templates with tag type arguments or `<define>` type parameters that compile
successfully no longer fail the editor's independent source-mapping pass.
The mapping pass erases only those tag containers through the opt-in
`parseFragment` option `stripTagTypes`; expression types and authored error
positions remain intact, and other fragment callers retain their existing
behavior.
