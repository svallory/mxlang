---
packages: [host-preact, host-react, host-hono, tsx-bridge]
kind: Fixed
---

A lone sequence placeholder (`<if=c>${0, x}</if>`) as the only child of a branch compiles to valid TSX on React. A `NaN` `class`, `className` or `style` is omitted, as stock Marko omits it, instead of printing `class="NaN"`. A method shorthand in a dynamic tag's props or an attribute-tag attribute maps its head and body exactly. `<html-script>` with an event handler (`onclick() {}`, `onClick=fn`) is refused on the JSX hosts, as it is on the html target. In `.<host>.mx` regions, a type error in a generic constraint of a method shorthand's head (`onClick<T extends Missing>(e: T) {}`) is reported at the authored span.
