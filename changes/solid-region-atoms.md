---
packages: [tsx-bridge, babel]
kind: Fixed
---

A TypeScript error inside a region expression the host rewrote (an atom, a `<for>` index or key read) is no longer dropped: a host may return optional `mappings` from `mxRegionCompile`, and the bridge maps emitted nodes back to the authored span from them instead of searching the emitted text for each authored expression.
