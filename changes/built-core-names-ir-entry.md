---
packages: [core]
kind: Fixed
---
A custom tag's hook that builds `<if>`, `<else-if>`, `<else>`, `<for>`, `<define>` or `<return>` (under every tag-rules preset) or `<class>` (under every preset but `none`) through `ctx.build.delegatedTag` now fails with `MX_TAG_HOOK_ERROR` (`` `<widget>`: `ctx.build.delegatedTag` cannot build `<for>`: a built tag has no loop head ``), and on `lowerSource` a built `<try>`, and outside the `none` tag rules a built `<effect>`, fails as an unclaimed name, instead of `lowerSource` recording a tag that skips the refusal its authored form gets. Under the `none` tag rules `<let>` and `<id>` are ordinary tags and no longer get the `value=` attribute checks.
