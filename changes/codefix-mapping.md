---
packages: [typescript-plugin]
kind: Fixed
---

A TypeScript quick fix (or fix-all) whose edit would be mapped through a verification-only mapping is no longer offered on an `.mx` file. Such a mapping only places a diagnostic on authored text that the generated code is not, so the edit used to rewrite unrelated source: TS6133's "Prefix 'input' with an underscore" inserted `_input` at the start of an html page. Fixes on authored code are unchanged.
