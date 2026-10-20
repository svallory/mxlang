---
packages: [core]
kind: Fixed
---
A two-way binding (`:=`, `:x:=`, `:fn:=`) whose value is a `<const>` bound as a plain name is now a compile error, as it is in Marko: the binding writes back into the const on every change. A name from a `<const>`'s object pattern, a member of a const value and a `<let>` keep compiling. A write to a `<const>` above its declaration is refused too (`MX_CONST_WRITE_BEFORE_DECLARATION`), while a read above it still compiles, as in Marko; where a `<const>` above and one below share a spelling, the write is refused against the one above.
