---
packages: [core, html]
kind: Added
---
The declaration of a tag variable is mapped to the authored `/var` on html: hover on the `/el` in `<div/el/>` reads its type, and go-to-definition and rename from a read of `el()`, a `<let>` or `<const>` name (each name a destructuring pattern declares), a call's `/var` or a `<define>`'s name reach the authored text. The mappings serve navigation and hover only, so no new diagnostic appears at a `/var`. The IR gains an optional `varSpan` (the authored `/var` pattern's span) on `Element`, `Component`, `DelegatedTag` and `Const`, and an optional `varBindings` on `DelegatedTag` (`IR_VERSION` 20). Core exports `mappedVar(code, varSpan, bindings?)`, which maps each declared name from those spans. The other hosts do not map the declaration yet.
