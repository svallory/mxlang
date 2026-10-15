---
packages: [core]
kind: Fixed
---
A type-only import (`import type x`, `import type { x }`, `import { type x }`, `import type * as x`) beside a real declaration of its name is refused exactly where stock Marko refuses it, `MX_DUPLICATE_DECLARATION` at the second name, instead of compiling. The answer depends on the order, as in stock: a type-only import after a `const`, `let`, class, value `import`, `declare const` or `declare let` of its name is refused, and so is a `let`, class or `declare let` after one. Everything else still compiles: a `const` after a type-only import, an `import x = M.N` alias before one, a `var`, function or `declare var` in either order, an enum, a namespace, a type, and another type-only import. The specification's duplicate-binding paragraph now states this rule instead of saying a type-only name never collides.
