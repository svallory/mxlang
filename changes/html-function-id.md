---
packages: [html]
kind: Fixed
---
The ids `mx()` and `loadMx()` give option functions (`resolveImport`, custom-tag hooks) for their cache keys now count per loader instead of per process, so a loader no longer depends on what other compiles ran before it. Emitted code is unchanged.
