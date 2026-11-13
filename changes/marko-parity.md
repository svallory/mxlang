---
packages: [core, html, preact]
kind: Fixed
---

`<log/>` and concise `log` with no value are now refused with "The `<log>` tag requires a `value=` attribute." (`MX_INVALID_ATTRIBUTE`) at the tag name, as Marko refuses them, on the html target and on every host that lowers `<log>` through core; `<log=1/>`, `<log value=1/>` and `<debug/>` still compile. The inert `Disposition` gains an optional `value?: "required"` for this. A named tag that core lowers as a dynamic tag (a value import such as `import Foo from "./foo.js"`, or a local whose value it cannot prove is a function) now refuses arguments beside a plain attribute (`<Foo(a) x=1/>`: "Tag does not support arguments when attributes or body present.", at the arguments) instead of compiling with the attribute dropped; arguments beside a body still compile. An authored dynamic tag over a namespace import's member (`import * as J from "hono/jsx"` then `<${J.Fragment}>…</>`) now carries the new optional IR field `importMember` on its dynamic target (`IR_VERSION` goes from 10 to 11), and the JSX hosts pass its body as hand-written JSX would, so on Hono a lone `0` renders nothing, as `<J.Fragment>{0}</J.Fragment>` does.
