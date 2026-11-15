---
packages: [core, html, preact, solid, angular]
kind: Added
---
`<return>` inside a `<define>` body, as in Marko 6.4.4: `<define/Thing|input|><return=input.n * 2/><i>${input.n}</i></define><Thing/double n=21/>` binds `double` to `42` and renders `<i>21</i>`. core lowers the value onto `Define.returnValue` (`IR_VERSION` 15), applies the position and count rules per define, accepts `/var` on a call of a define that returns (`Component.returnsValue`) and refuses a `/var` that repeats the define's name as a duplicate declaration. html, Preact (and through it React and Hono) and Solid (in `.solid.mx` regions) bind the value on a `/var` call and render only the output everywhere else. Angular refuses the `<return>` at its value (`MX_UNSUPPORTED_CONSTRUCT`), as it refuses a page's or a tag's own.
