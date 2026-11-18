---
packages: [core, html]
kind: Fixed
---
A custom tag's hook that builds `<static>`, `<import>` or `<export>` through `ctx.build.delegatedTag` now fails with `MX_TAG_HOOK_ERROR` under every tag-rules preset (``ctx.build.delegatedTag` cannot build `<static>`: a built tag has no statement code``), instead of `lowerSource` recording a tag that carries none of the statement and that `structural: "reject"` did not see. Under the `none` tag rules the html target no longer treats `<let>`, `<server>` and `<client>` as Marko's: an authored one is an ordinary tag (before, `<server>x</server>` hoisted its markup as module code and `<client>x</client>` parsed it as statements), and a custom tag that builds one fails as an unclaimed name (`` `<widget>`: this host does not claim `<server>`, so a custom tag cannot emit one ``).
