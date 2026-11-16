---
packages: [core]
kind: Fixed
---
A PascalCase tag whose name a closer local binding shadows (a tag param, a `<for>` loop variable or a `<const>`) now calls that local as a dynamic tag, as stock Marko does, instead of the outer `<define>` of the same name. html rendered the define there, and Preact, React and Hono refused a `/var` on the call.
