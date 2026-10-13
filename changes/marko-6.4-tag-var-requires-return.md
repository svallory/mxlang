---
packages: [core]
kind: Changed
---
A `/var` on a call to a tag whose template declares no `<return>` (a discovered `tags/` tag or an imported `.mx` unit) was already a compile error (`MX_INVALID_TAG_VAR`, "`<badge>` does not return a value; add `<return value=…/>` to … to bind it with `/var`"), which Marko 6.4 now refuses too. The error is now reported at the tag variable with its end, as Marko does (`<badge/b/>` underlines `b`), where it used to point at the start of the tag and carry no end. The tag variable's span is available on `TagCall` as the optional `varSpan`. A falsy dynamic tag name (`null`, `false`, `undefined`, `""`, `0`) renders nothing and leaves its `/var` `undefined` on html, Preact, React and Hono, as in Marko; Solid and Angular refuse a `/var` on a dynamic tag at compile time.
