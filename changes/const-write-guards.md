---
packages: [core, angular]
kind: Fixed
---
A two-way binding (`:=`, `:x:=`, `:fn:=`) whose value is a `<const>` bound as a plain name is now a compile error, as it is in Marko: the binding writes back into the const on every change. A name from a `<const>`'s object pattern, a member of a const value and a `<let>` keep compiling. A write to a `<const>` above its declaration is refused too (`MX_CONST_WRITE_BEFORE_DECLARATION`), while a read above it still compiles, as in Marko; where a declaration above and one below share a spelling, the nearer (innermost, later) declaration decides. A binding above a `<let>` or a plain-name `<const>` declaration is refused like any other write above it, and an inner `<let>` or `<const>` now shadows a same-named declaration below its block for every write after it in that block, however many siblings sit between them. On Angular, `value:=a` on a `<const>` used to emit `[(value)]="a"` on a `@let` and is now refused at the value.
