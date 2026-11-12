---
packages: [core, target-html]
kind: Fixed
---

`<define>` and tag-variable checks now match stock Marko 6.4.4 in four places. A `<define>` name read after the body that declares it (`<if=input.a><define/Foo>x</define></if>${typeof Foo}`), or above a `<define>` in a nested body (`<script>…D…</script><div><define/D>x</define></div>`), is refused with `MX_DEFINE_READ_BEFORE_DECLARATION`. The same `<define>` name in two native element bodies, or in an element body and its enclosing body, is refused with `MX_DUPLICATE_DECLARATION`. On `@mxlang/target-html`, the refusal of `/var` on an imported value a call cannot read now also names `<${Name}/var/>`; hosts whose dynamic tag does not bind `/var` keep the plain message.
