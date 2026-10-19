---
packages: [preact, react, hono]
kind: Fixed
---

Whole-file JSX templates now reject collisions among `<const>`, lifted `<define>` and static or dynamic `/var` bindings, rather than emitting duplicate `const` declarations. Earlier markup errors remain visible before top-level duplicate checks, and separate define-body and parameter scopes remain legal. Rename one binding and its uses to keep each name unique in the component scope. Destructured `<const>` patterns claim every bound identifier, including nested, renamed, default and rest bindings. The existing dynamic-tag and try-body scope limitation is recorded in `divergences.md`.
