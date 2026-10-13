---
packages: [html]
kind: Fixed
---
A `client` block now declares its names on the html target, as Marko's server render does. `client { let q = 1 }` used to leave nothing behind, so a template that read `q` threw a ReferenceError; the module now declares `var q;` (no initializer, the block's code never runs), and the template renders `undefined`. The names are the block's own top-level declarations: `let`, `const`, `var`, `function`, `class` and the names a destructuring pattern binds. Declarations inside nested blocks (`if`, `try`, a bare `{}`) and a `for (let i …)` loop's own binding are not declared. Each `client` statement emits one `var`, and `client`, `server` and `static` statements now keep the order they were written in (a `server` block written before a `static` block used to be emitted after it).
