---
packages: [tsx-bridge]
kind: Fixed
---
Two `.solid.mx` regions that hoist different `<define>`s with the same generated name now each call their own define, including from inside another hoisted define and through a `<return>` define's `/var` and parameter types; an identical-text define is shared between regions only when the defines it calls are the same ones.
