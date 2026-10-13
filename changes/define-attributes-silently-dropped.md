---
packages: [core, html, preact, react, hono, solid, angular]
kind: Fixed
---
A `<define>` tag's own attributes are no longer dropped. `<define/D a=1 b="s"/>` compiled, and `${D.a}` read `undefined`; Marko makes the attributes properties of the define's value, and MX now does too. On html, preact, react and hono they are own properties of the function a call runs (a spread keeps its place, a repeated name is last-wins, and attributes named `name`, `length`, `caller` or `arguments` work), evaluated where the `<define>` is written and outside its params. A `<let>` written in one (`<define/D a=(count++)/>`) is now refused like in any attribute. A `content` attribute next to a body is refused (the body is `content`) and is an ordinary property when the define has no body. Solid and Angular cannot expose a property on their define (a hoisted function, a template reference) and now refuse a `<define>` with attributes with a positioned error instead of dropping them; Astro already refuses `<define>`.
A `Define` IR node now carries its `attrs`, so `IR_VERSION` goes from 3 to 4.
