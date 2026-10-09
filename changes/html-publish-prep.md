---
packages: [core, html]
kind: Fixed
---

Publish prep for `@mxlang/html` and the repository metadata: `@mxlang/html` ships its `LICENSE` and declares `publishConfig.access: public`; every `repository` URL points at `github.com/svallory/mxlang`; the README and docs example import the named `translator` and lead with `compile`; `@mxlang/core` writes `dist/THIRD-PARTY-NOTICES.md` with the licence text of the vendored `@babel/parser`, `@babel/helper-validator-identifier` and `charcodes` that `dist/index.js` bundles.
