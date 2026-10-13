---
packages: [parser]
kind: Fixed
---
An expression trigger row now arms after `await` or `yield` wherever the keyword stands. A guard kept the keyword an identifier after `?` or `:`, so `{ k: await &a }`, `c ? await &a : 1`, `c ? await ++&n : 1` and `(c ? await :b : d)` armed nothing and reached Babel unreplaced. `await` is a reserved word in a template (an ES module), so the guard protected no valid code: stock Marko rejects `c ? await : b` with "Unexpected token", and so does MX. One case keeps its reading: a `:` right after a `yield` that follows `?` or `:` is the ternary's colon, so `c ? yield :b` is still `c ? (yield) : b` in a generator, while `c ? yield &a : 1` arms. The look-behind table in the parser grammar page describes the rules.
