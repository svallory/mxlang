---
packages: [core]
kind: Fixed
---
A custom tag's hook that builds `<let>`, `<const>`, `<server>`, `<client>` or a dynamic tag through `ctx.build.delegatedTag` now fails with `MX_TAG_HOOK_ERROR` naming what the builder cannot carry (`` `<widget>`: `ctx.build.delegatedTag` cannot build `<let>`: a built tag has no tag variable to bind ``), instead of the host reading the custom tag's own tag variable, attributes, source text or name: html refused the custom tag as a `<let>` without a variable, hoisted the tag's own markup as module code for `<server>`, parsed it as `<client>` statements, and rendered the custom tag itself as the dynamic target; Angular did the same for a dynamic tag. Under the `none` tag rules `<let>`, `<server>` and `<client>` are ordinary names and still build.
