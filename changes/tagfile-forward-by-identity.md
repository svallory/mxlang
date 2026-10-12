---
packages: [core]
kind: Changed
---
A `tagFile` hook that copies or rewrites a diagnostic `ctx.lower` returned no longer forwards it under an `MX_` code: return the object itself (`diagnostics: lowered.diagnostics`, or push each element as it is). Core now checks that the diagnostic is the object `ctx.lower` returned, not that its code is one `ctx.lower` reported, so a hook cannot put its own message under an `MX_` code. A copy or a reworded diagnostic under an `MX_` code is refused as `MX_DIALECT_HOOK_ERROR`, as a made-up `MX_` code already was; a code of the dialect's own prefix is unchanged.
