---
packages: [core, solid]
kind: Fixed
---
On Solid, a `<define>` in a `.solid.mx` region whose body names a TypeScript type (`<define/D><button onClick(e: MouseEvent) { e }/></define>`) now compiles instead of being refused with `` cannot close over `MouseEvent` ``: a type is erased and names no value, so it is not a capture. A `typeof` query still reads its value (`typeof missing` is still refused). Core's `freeIdentifiersInProgram` adds the optional `typePositions` option (default `true`); `false` leaves out names read only in a type position, except a `typeof` query's value.
