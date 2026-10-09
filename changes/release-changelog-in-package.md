---
packages: [core, data, tsx-bridge, html, angular, angular-checker, typescript-plugin, language-server, vite-plugin, tsc, tree-sitter-mx]
kind: Changed
---
`CHANGELOG.md` is now part of every published tarball (`files` lists it in all packed packages); `bun pm pack` honours `files` only, so the alpha.11 tarballs carried just `README.md` and `dist`.
