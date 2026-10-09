---
packages: [core, angular, astro]
kind: Fixed
---

A custom tag's `ctx.build.element(name)` without a `void` option is now void exactly when an authored `<name>` is: the target's `nativeTags` declares it void, else core's own HTML void elements. It defaulted to `void: false` before, so `ctx.build.element("br")` rendered `<br></br>` on `@mxlang/angular` and `@mxlang/astro` (`@mxlang/html` hid it by re-reading core's void names, which its emitter no longer does). An explicit `void` still wins (review 475 r3, decision 197). `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).
