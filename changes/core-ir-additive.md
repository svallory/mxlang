---
packages: [core, html, preact, solid]
kind: Fixed
---

Type parameters written on a `<define>` (`<define/Foo<T>|{ v }: { v: T }|>`) are kept on its function head instead of being dropped while the params kept their annotations, which left `T` undefined: html and Preact (React and Hono share the emitter) print `<T,>`, Solid prints `<T>`, and the new IR field `Define.typeParams` (`{ code, span }`) carries them. A type error inside a shorthand placeholder (`<div.a${y}.b/>`, `<div#a${y}/>`) is now reported at the placeholder's own column instead of one or two columns off: the new IR field `Expr.parts` gives each authored expression inside a shorthand value core built its span and printed range, and `mappedExpr` maps each one onto its own source. A statement's `end` (`Import`, `Static`, `Export`, `InputInterface`) now stops at the authored text, trailing spaces excluded. `IR_VERSION` is 10.
