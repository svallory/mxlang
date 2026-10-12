---
packages: [preact, react, hono, solid]
kind: Fixed
---

An undeclared colon tag name such as `<uuid:id/>` is now a compile error on the React, Preact, Hono and Solid hosts, at the tag, instead of an emitted JSX namespace element. A colon is part of the tag name, so the name is one custom tag; with nothing declaring it, the message is `` Unable to find entry point for custom tag `<uuid:id>`. A colon belongs to the tag name: write the name without the colon, or declare it from an `mx.tags` directory with `prefix: "uuid:"`. ``, with Marko's `Did you mean `<div>`?` suggestion when the name starts with an HTML element name (`<div:x/>`). An import cannot bind a colon name and a `tags/` file name cannot spell one, so the `mx.tags` prefix directory (or a `customTags` contract) is how a colon tag is declared; a tag declared either way still compiles. React, Hono and Preact share one emitter, so the rule is the same in all three and in their `.react.mx`, `.hono.mx` and `.preact.mx` regions.

On Solid, an unresolved tag (`<TotallyUndefined/>` as well as a colon name) now carries its `line` and `column`; the error was thrown with both `undefined` before, so a `.solid.mx` file reported it at the start of the enclosing region.
