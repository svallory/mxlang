---
packages: [tsx-bridge, angular, typescript-plugin, language-server, vite-plugin]
kind: Fixed
---
The `@mxlang/tsx-bridge`, `@mxlang/host-angular`, `@mxlang/typescript-plugin`, `@mxlang/language-server` and `@mxlang/vite-plugin` dists now ship `dist/THIRD-PARTY-NOTICES.md` with the MIT licence of the bundled `@babel/parser` fork and its two inlined helpers (`@babel/helper-validator-identifier`, `charcodes`), as `@mxlang/core` already does. Each notice's heading names the dist files that bundle the fork, and so does core's.
