---
packages: [core, html, preact, react, hono, solid, angular, astro]
kind: Fixed
---

A custom tag's `ctx.build.element(name)` without a `void` option is now void exactly when an authored `<name>` is: the target's `nativeTags` declares it void, else core's own HTML void elements. It defaulted to `void: false` before, so `ctx.build.element("br")` rendered `<br></br>` on `@mxlang/angular` and `@mxlang/astro` (`@mxlang/html` hid it by re-reading core's void names, which its emitter no longer does). An explicit `void` still wins (review 475 r3, decision 197). A void element built with children, by default or with `{ void: true }`, is now a compile error at the tag ("`<br>` is void and takes no children; pass { void: false } to emit an end tag"): `@mxlang/html` dropped those children silently; `@mxlang/angular` and `@mxlang/astro` emitted `<br>child</br>`; and the JSX hosts (`@mxlang/preact`, `@mxlang/react`, `@mxlang/hono`, `@mxlang/solid`) compiled it to `<br>child</br>` JSX, which React rejects at runtime.
