---
packages: [core]
kind: Fixed
---
`/var` on a dynamic tag naming a `<define>` that declares `<return>` (`<${U}/z n=3/>`) binds the define's value on html, Preact, React and Hono, as in Marko 6.4.4; on a define without `<return>` it stays refused, and Solid, which binds no `/var` on a dynamic tag, refuses it at the `/var`.
