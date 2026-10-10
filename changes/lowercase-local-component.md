---
packages: [core, html, preact, react, hono, solid, astro, angular]
kind: Fixed
---

A lowercase tag naming a file-local binding is now Marko's own error, in
core, on every target — same message verbatim, same position (the tag name):
`Local variables must be in a [dynamic tag](https://markojs.com/docs/reference/language#dynamic-tags) unless they are PascalCase. Use `<${layout}/>` or rename to `Layout`.`
Before, the error existed only for a tag binding (a `<define>` or a `.mx`
default import) and in core's own wording ("`<layout>` is not a tag here…"),
a lowercase **value** import (`import layout from "./layout.ts"` then
`<layout/>`) was a silent pass on preact, react, hono, solid and astro (a
literal lowercase element was emitted) and only html rejected it, through its
own `rejectComponentTag` hook (now removed — core covers it). The message and
position are measured on the stock parser (`@marko/compiler` 5.42.11 /
`marko` 6.4.4): identical for a tag import, a value import and a `static
const` local. Decision 164's matrix is otherwise unchanged: a name that is a
native element stays native (silent for a value binding, the existing warning
for a tag binding), a registered custom tag or a host claim still wins
whatever is imported, and `_`/`$`-prefixed names follow Marko's message (its
naive capitalization offers "rename to `_row`").
