---
packages: [core, html, preact, react, hono, solid, angular]
kind: Fixed
---
A `<define>` is now scoped to the body that declares it, as in Marko. A `<define/Foo>` inside an `<if>`, `<else>`, `<for>`, component body or native element used to stay callable for the rest of the file, so a later `<Foo/>` outside it called the define even when `Foo` was also an import (html called the define, Solid hoisted the define and called it), and with no import it compiled instead of reporting an unresolved tag. The `<Foo/>` outside the body now renders the import, or reports "Unable to find entry point for custom tag" when there is none; inside the body the define still wins. A top-level `<define>` is unchanged and is visible in every later body.
