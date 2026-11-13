---
packages: [html, core, typescript-plugin]
kind: Fixed
---

A `client` name that a `server`, `static`, `import` or `export` statement also declares at run time no longer gets a `var` in the module that runs, so `server const x = 1;` beside `client for (const x of …)` or `client x: for (;;)` loads instead of failing with a redeclaration; a `static`/`server` label or `for … of` head no longer suppresses a client name's `var`. In editors, definition, rename and hover from a refinement token (`value:clamp:=q`) reach the `client` binding it names. In editors and `mx-tsc`, a `<for>` param's type annotation (`<for|x: string| of=list>`, in the `of`, `in` and range forms and in attribute-tag loops) is checked against the element, at the param. Added in core: `MappingUse` and an optional `use` on `GeneratedMapping` (what tooling may use a mapping for), and `withUse`; the TypeScript plugin passes a recorded mapping's `use` to Volar.
