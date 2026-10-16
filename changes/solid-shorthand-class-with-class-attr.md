---
packages: [solid]
kind: Fixed
---
A shorthand class that has a placeholder after a static word (`<div.a.${y} class="c"/>`, `<div.b.a${y} class="c"/>`) now merges with a string or object-literal `class=` on Solid instead of being refused with the "combine shorthand with a string class" error. It renders the same class string as the other hosts and stock Marko: the shorthand parts first, then `class=`, one space apart. A shorthand with a static word still refuses any other dynamic `class=` (an identifier, a call, a ternary).
