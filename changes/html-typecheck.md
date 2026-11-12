---
packages: [core, html, preact, astro]
kind: Fixed
---

The html and preact type-check projection now reports errors it dropped: the annotation of `<const/c: string = n/>` and `<let/c: T = n/>` is kept; the initial value of `<const>`/`<let>`, `<let valueChange=…>` and the default value of an inert tag (`<id=x/>`, `<log=x/>`) are evaluated and mapped to their authored text; an angle assertion (`<T>x`) inside an expression is printed `(x as T)` so tsc no longer reads it as a JSX tag (core, `stripTypes: false` only); and the html spread loop no longer raises TS2367 on generated code. The html target prints a `<for|x: number, i: number|>` head without the annotations (it was invalid JavaScript), and inlines the member reads of an unexported `const enum` (`${E.A}`, `${E["A"]}`) and drops its declaration, as stock Marko does. The `.astro.mx` attribute helper returns `any`, so `<p title=s/>` with `s: string` no longer reports a false TS2322 under `mx-tsc --astro`.
