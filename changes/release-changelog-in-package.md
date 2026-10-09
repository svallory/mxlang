---
packages: [core, data]
kind: Changed
---
`CHANGELOG.md` is now part of the published tarball (`files` lists it); `bun pm pack` honours `files` only, so the alpha.11 tarballs carried just `README.md` and `dist`.
