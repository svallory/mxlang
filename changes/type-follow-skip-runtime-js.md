---
packages: [core]
kind: Fixed
---
Following a type-only import to read a component's input types no longer parses runtime JavaScript: a `.js`, `.jsx`, `.mjs` or `.cjs` target (direct or through an `export … from` re-export) counts as unresolved, so a file with `import type { … } from "<package>"` no longer re-parses that package's JS bundle on every compile. `.mts` and `.cts` targets are now followed.
