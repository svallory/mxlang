---
packages: [angular]
kind: Fixed
---
A dynamic `class=` in a `.ng.mx` file now renders any value Marko accepts. `<div class=y/>` and `<Tag class=y/>` with a number threw `Unsupported styling type: number` in Angular's `[class]`, and a nested runtime array printed its parts unjoined. A `.ng.mx` owns its component class, so the injected `__mxClass` joins the value (an object literal keeps `[ngClass]`). A plain `.mx` page is unchanged.
