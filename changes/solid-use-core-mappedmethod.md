---
packages: [solid]
kind: Changed
---

- solid: method shorthand attributes (`onClick() { … }`) now map through `@mxlang/core`'s `mappedMethod` instead of a local copy of the same helper. Emitted code and source maps are unchanged.
