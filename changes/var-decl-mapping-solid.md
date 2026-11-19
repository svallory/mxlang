---
packages: [solid]
kind: Added
---
The declaration of a tag variable is mapped to the authored `/var` on Solid: hover on the `/el` in `<div/el/>` reads its type, and go-to-definition and rename from a read of `el()` or of a call's `/var` reach the authored text, in a whole-file unit and in a `.solid.mx` region. A `/var` Solid renames because another body repeats its name (`__mxVar0_el`) maps as a whole onto its own authored name. The mappings serve navigation and hover only, so no new diagnostic appears at a `/var`, and the emitted code is unchanged.
