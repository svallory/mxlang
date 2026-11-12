---
packages: [host-angular, angular-checker]
kind: Fixed
---

NG8112 (unused `@let`) is now positioned at the authored `<const>` tag instead of the start of the `template:` region. Assigning a renamed `<define>` that has attributes keeps the hint to read them as `D.name`. A tag call to a callee that declares a `style` input passes a static `style="…"` to the input only, and a bare `class` passes `true` to a declared `class` input, as Marko does.
