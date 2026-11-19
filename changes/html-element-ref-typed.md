---
packages: [html]
kind: Fixed
---
In the type check (the TypeScript plugin and `mx-tsc`), an html element reference's getter is typed by its tag: `el()` on `<div/el>` returns `HTMLDivElement` (the SVG element type for an SVG tag, `HTMLElement` for any other name), so `el().` in a handler passed to a custom tag or a `<define>` call lists the element's members and a misspelled member is a type error at the member. Before, `el()` was `any`. The build output is unchanged: the getter keeps `(): any` and throws when called.
