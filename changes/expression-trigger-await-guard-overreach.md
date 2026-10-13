---
packages: [parser]
kind: Fixed
---
An expression trigger row now arms after `await` or `yield` wherever the keyword stands. A guard kept the keyword an identifier after `?` or `:`, so `{ k: await &a }`, `c ? await &a : 1`, `c ? await ++&n : 1` and `(c ? await :b : d)` armed nothing and reached Babel unreplaced. `await` is a reserved word in a template (an ES module), so the guard protected no valid code: stock Marko rejects `c ? await : b` with "Unexpected token", and so does MX. A keyword operator written right against a trigger (`typeof&n`, `f(await&a)`) still arms nothing, because the stand-in would join the keyword into one identifier; Babel rejects the raw text. The look-behind table in the parser grammar page describes the rules.
