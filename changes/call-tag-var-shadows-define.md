---
packages: [core, preact]
kind: Fixed
---
A tag call's `/var` (`<Make/T/>`) now hides a `<define>` of the same name in its body and the bodies nested in it, so `<T/>` there calls that value as a dynamic tag, as stock Marko does, instead of the outer `<define>`. html rendered the define there without `/var`, and with `/var` bound the define's value. Preact, React and Hono refused a `/var` on that call; they now bind it, and a `/var` on any dynamic tag whose value is a `<define>` that declares `<return>` now binds that define's value instead of `undefined`.
