---
packages: [core, html, preact, react, hono, solid, angular, astro]
kind: Changed
---
A decorator in a module statement is now a positioned compile error, as in Marko, whose parser has no decorators plugin. `static @d() class C {}`, `server @d() class C {}`, `client @d() class C {}` and a decorated class member (`static class C { @d m() {} }`, a property, an accessor or a parameter) compiled before and are refused now with `MX_INVALID_STATEMENT`, on every target. The error sits on the first `@` and its span covers that decorator; the same holds for `static { @d class C {} }`, `export @d class C {}` and a class expression. The message says what to do: move the decorated class to a `.ts` module and import it, or apply the decorator as a plain function call. A class with no decorator is unchanged.
