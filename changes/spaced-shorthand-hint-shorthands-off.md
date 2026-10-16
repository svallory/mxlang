---
packages: [core]
kind: Fixed
---
In a file whose syntax table sets `tagShorthands: false`, a spaced `#a` or `.a` in a tag head (`div #a`, `<div .a>`) no longer gets the advice to put the shorthand on the tag name with no space (`<div#a>`), which is itself refused in that file as `MX_NO_TAG_SHORTHAND`. The `MX_INVALID_ATTRIBUTE` message now says the file's dialect has no `#id` (or `.class`) shorthand and to write `id=` (or `class=`) as an attribute, in the words `MX_NO_TAG_SHORTHAND` uses; the shorthand named is the one the name starts with. The default table's message is unchanged, except that its two tag examples (`<div#a>`, `<div.cls>`) are now spelled by the dialect's `formatTag` like every other tag in a message, and the attribute noun in the new message is the dialect's. The table is read from the file's resolved syntax, so a bare table passed as the `dialect` option counts too.
