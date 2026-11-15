---
packages: [preact, solid]
kind: Changed
---
A `/var` inside a `<for>` body, an `<if>`/`<else-if>`/`<else>` branch, an attribute-tag body or a call's content now binds in that body's own scope, as in Marko 6.4.4 and the html target, instead of failing with "`/var` on `<X>` inside `<for>`/`<if>` is not supported … yet". It binds once per row or rendered branch, reads the row's own bindings, and can sit beside an outer `/var` of the same name. On Preact, and on React and Hono, which compile through the Preact emitter, the body's statements run in a function called in place; a `.preact.mx`/`.react.mx`/`.hono.mx` region accepts it too, including in a region `<define>` body. On Solid, a `<For>` row, a `<Show>`/`<Match>` branch, a call's content and a `<define>` body declare their own `let` for the binding.
