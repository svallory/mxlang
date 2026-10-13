---
packages: [core, language-server, tsc, typescript-plugin, vite-plugin]
kind: Fixed
---
Two more `MX_INVALID_TAG_VAR` errors now point at the tag variable with its end, as the "declares no `<return>`" error beside them already does: a `/var` on a tag with no template (an L2 sidecar: "it has no template, so it has no `<return>` to bind") and a `/var` on an imported `.mx` unit that cannot be read ("`/n` on `<B>` can't bind: … does not exist / does not compile"). `<box/x/>` underlines `x`, where both used to point at the start of the tag and carry no end, so an editor or `mx-tsc` showed the squiggle on the tag name instead of on the variable to remove. A multi-line destructuring pattern is covered whole, and a region of a `.preact.mx` file reports the same file-absolute position.
