---
packages: [host-solid]
kind: Fixed
---

The Solid emitter numbers its generated dynamic-tag and escaped-value names (`__mxDyn<N>`, `__mxText<N>`) per compile instead of across the process, so compiling the same source twice gives identical output in a long-lived Vite or language-server process.
