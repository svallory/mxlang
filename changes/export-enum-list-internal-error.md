---
packages: [core]
kind: Fixed
---
An exported enum and an export list of its name in one `static`, `server` or `client` block (`static { export enum q { A }; export { q } }`, in either order) is refused at the second `q` with `MX_DUPLICATE_DECLARATION`, naming the first, like the same two statements written apart. It used to fail with a positionless `MX_INTERNAL_ERROR` ("Duplicate declaration") at 1:0, and a raw Babel error from the html target. The module it makes would not load, as stock Marko's does not.
