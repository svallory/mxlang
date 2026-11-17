---
packages: [core, tsx-bridge, angular, typescript-plugin, language-server, vite-plugin]
kind: Fixed
---
Each dist's `THIRD-PARTY-NOTICES.md` now carries the licence of every npm package it inlines (such as `@babel/generator`, `magic-string`, `preact` and `entities`), and of the vendored htmljs-parser copy, not only the Babel fork's. The notices are generated from the modules each built file actually inlines.
