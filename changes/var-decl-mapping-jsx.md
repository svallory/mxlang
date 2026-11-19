---
packages: [preact, react, hono]
kind: Added
---
A tag variable's declaration (an element reference `<div/el/>`, a `<const>` pattern's names, and a dynamic tag's, a returning `<define>` call's or a `.render` call's `/var`) now maps to the authored `/var` in a whole file and in a `.preact.mx` or `.react.mx` region, so hover on the declared name reads its type and go-to-definition and rename from a read reach it. The emitted code is unchanged.
