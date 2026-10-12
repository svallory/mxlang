---
packages: [html, preact, react, hono, solid]
kind: Fixed
---
A `<define>` with a rest parameter called with tag arguments and a body or attribute tags now receives the trailing `{ ...attributeTags, content }` object in the rest array, as in Marko, when the arguments already fill every fixed parameter. `|a, ...rest|` called as `<D(1, 2)>x</D>` now reads `rest = [2, { content }]` (and `<D(1, 2, 3)>x</D>` reads `[2, 3, { content }]`), where the object used to be dropped and `rest` was `[2]`. The same holds for a define whose only parameter is `...rest`. A call with no body and no attribute tags still appends nothing, and a rest parameter is still never padded with `undefined`. Defines without a rest parameter are unchanged: when the arguments fill every parameter the extras are dropped.
