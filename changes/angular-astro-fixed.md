---
packages: [angular-checker]
kind: Fixed
---

The emitted declarations no longer import `@angular/compiler-cli`, so a consumer that type-checks with `moduleResolution: node16` no longer fails with TS2834 inside compiler-cli's own `.d.ts`. `CompilerCliModule` is now a structural interface of the two exports the package reads (`NgtscProgram`, `readConfiguration`).
