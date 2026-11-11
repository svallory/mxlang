---
packages: [html]
kind: Fixed
---
`mx()` and `loadMx()` no longer depend on what ran before them in the process: their in-memory module versions, module text and compile caches no longer outlive or leak into another copy of the module, so a second copy (a test runner's module reset) can no longer collide with modules the first one evaluated. The Node hook is still registered once per process.
