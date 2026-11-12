---
packages: [angular]
kind: Fixed
---

A scan diagnostic is now reported once per `build()` or watch session instead of once per process, so a second build in the same process reports the problems it still has.
