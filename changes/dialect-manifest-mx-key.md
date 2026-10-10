---
packages: [core]
kind: Changed
---

A target's config key (`configKey`, else its name) cannot be `dialect`: `mx.dialect` is a dialect package's identity block, never a target's config block. `createTargetLookup` refuses such a descriptor with the new `reserved-config-key` rule, and a loaded `mx.target` / `mx.host` descriptor that takes it is a positioned error at that key.
