---
packages: [preact, react, hono]
kind: Fixed
---
A call that carries a `/var` (a returning `<define>` call, a returning unit's `.render` call, or a dynamic tag) now maps its attribute values, its `<define>` tag name and a dynamic tag's body as the same call does without the `/var`, so hover and go-to-definition work there and a type error in an attribute value is reported at the authored position. The emitted code is unchanged.
