---
packages: [preact, react, hono]
kind: Fixed
---
The emitter now records source mappings for a call that carries a `/var` (a returning `<define>` call, a returning unit's `.render` call, or a dynamic tag): its attribute values, its `<define>` tag name and a dynamic tag's body map as the same call does without the `/var`. Hover on the `<define>` tag name now reads the called function, and a type error in an attribute value maps to its authored position through the emitter's own mapping. The emitted code is unchanged.
