---
packages: [solid, angular]
kind: Fixed
---
A `<define>` with attributes (`<define/D a=1/>`, `${D.a}`) compiles on Solid and Angular and renders what Marko 6.4.4 does, where both used to refuse it. Static, dynamic and boolean attributes and a spread all become properties of `D`, with any number of defines, a define with params, and (on Angular) a define inside a `<for>` or an `<if>`. On Solid each read of `D` is the object of its attributes at the read, so it stays reactive; on Angular the attributes are a `@let` beside the template reference. Still refused with a positioned error: `D.content` of a define that has attributes and a body, a bound attribute (`a:=x`), and on Solid a define inside a `<for>`/`<if>` body (every define is hoisted there).
