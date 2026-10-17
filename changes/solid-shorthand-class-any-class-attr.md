---
packages: [solid]
kind: Fixed
---
A tag-shorthand class now merges with any `class=` value on Solid, as it does in Marko and on the other hosts. `<div.a class=y/>`, `<div.a.${x} class=y/>` and concise `div.a class=y` used to stop with "combine shorthand with a string class or use class={...}" unless `y` was a string or an object literal; they now compile to `class={["a", y]}` and render the shorthand first, then the value, joined by a single space. Objects, arrays (nested ones included), calls and ternaries all work, and `null`, `undefined` and `false` add nothing, so `<div.a class=null/>` renders `class="a"`. The error is gone.
