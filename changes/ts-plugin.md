---
packages: [typescript-plugin]
kind: Fixed
---

A malformed `package.json` beside an `.ng.mx` (with or without a separate `.mxrc.json`) is reported once, as the positioned host-policy diagnostic, instead of also as a second error and a logged scan warning. Fixing a `package.json` clears its host-policy warning at the next diagnostics request, without editing the `.mx`. `{ astro: true }` resolves `@astrojs/language-server` from the project first, so it works from the VS Code extension.
