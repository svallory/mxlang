---
packages: [solid]
kind: Fixed
---
A destructured `/var` on a call that returns a value (`<counter/{ a }/>`, a returning `<define>`) now compiles to valid code on Solid: each name it binds is declared on its own and mapped to its authored identifier, and the returned value is assigned to the pattern.
