---
packages: [core, html, preact, react, hono, solid, astro, angular]
kind: Fixed
---

A lowercase tag naming a local binding is now Marko's own error, in core, on
every target — same message verbatim, same position (the tag name):
`Local variables must be in a [dynamic tag](https://markojs.com/docs/reference/language#dynamic-tags) unless they are PascalCase. Use `<${layout}/>` or rename to `Layout`.`
The rule covers every local binding: a default or named `import` (a `.mx`
tag module or a `.ts` value alike), a lowercase `<define>`, a `<const>`, a
`<for>`/`<define>` tag param, and a `static` declaration (`static const
layout = 1` then `<layout/>`). A native-element name stays native (silently
for a value binding, with the existing warning for a tag binding); a
registered custom tag, a taglib tag or a host claim still wins whatever is
imported; a core taglib name (`<debug>`, `<log>`) keeps its own routing, as
in Marko. `_`/`$`-prefixed names follow Marko's message, whose naive
capitalization offers "rename to `_row`".

Before, the error existed only for a tag binding (a `<define>` or a `.mx`
default import) and in core's own wording ("`<layout>` is not a tag here…"),
a lowercase **value** import (`import layout from "./layout.ts"` then
`<layout/>`) was a silent pass on preact, react, hono, solid and astro (a
literal lowercase element was emitted) and only html rejected it, through its
own `rejectComponentTag` hook (now removed — core covers it). The `<const>`,
`static` and tag-param forms fell to the unknown-tag path at best (html) or
passed silently (the JSX hosts); a core taglib name bound by an import drew
the local-variable error on the JSX hosts, where Marko compiles the tag.

The message and position are measured on the stock parser
(`@marko/compiler` 5.42.11 / `marko` 6.4.4): identical for a tag import, a
value import, a `static const` local, a `<const>` and a `<for>` param. The
rest of the lowercase-tag rules are unchanged. One boundary, matching the
existing import behaviour: a use *before* the `import`/`static` statement is
not covered — bindings register in document order.
