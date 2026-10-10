---
packages: [html, preact, react, hono, solid]
kind: Fixed
---

- html, preact, react, hono, solid: a `<define>` called with tag arguments **and** a body or attribute tags now binds the extras the way Marko does: the call appends ONE trailing object (`{ ...attributeTags, content }`) as its next argument, so it lands in the define's first unfilled parameter and every parameter after it reads `undefined` (a rest parameter stays empty). Previously the remaining parameters were filled *by name* from the attribute tags and body, so `<Row(1)><@b>2</@b></Row>` bound `b` to the attribute tag's value and a parameter named `content` received the body renderable; now that parameter receives the whole `{ b: … }` object (destructure it: `|a, { b }|`) and the body arrives under `content` inside the same object. When the tag arguments already fill every parameter, the extras are dropped, as in Marko. The no-argument call is unchanged (one props object into the first parameter). On solid, a rest parameter of a no-argument `<define>` call is no longer padded with `undefined` either.
