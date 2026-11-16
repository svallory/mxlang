---
packages: [core]
kind: Fixed
---
A tag named by a tag call's `/var` in scope, after that call, is a dynamic call over that value even when no `<define>` of the name exists: `<Make/T/><T n=1/>` renders the component `Make` returns instead of failing with "Unable to find entry point for custom tag `<T>`", as in Marko 6.4.4. A `<T/>` above the call, or above a body's own `/T` below it, keeps that error.
`/var` on a dynamic tag naming a `<define>` that declares `<return>` (`<${U}/z n=3/>`) binds the define's value on html, Preact, React and Hono, as in Marko 6.4.4; on a define without `<return>` it stays refused, and Solid, which binds no `/var` on a dynamic tag, refuses it at the `/var`.
