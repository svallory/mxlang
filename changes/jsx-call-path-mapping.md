---
packages: [preact, react, hono]
kind: Fixed
---
In the type-check projection the TypeScript plugin compiles, a direct call to a `<define>` that declares `<return>` is now typed through the public define name: hover on the call's tag name reads the public `const` and go-to-definition reaches the `<define>` tag, where before both landed on the private `__mxDef_*` function. The emitter also records source mappings for more call parts, with or without a `/var`: prop keys, a dynamic tag's target expression and arguments, a `<define>` call's arguments, a returning unit's name in its call, and a called unit's body with its `content` key (diagnostics only, on the tag name). A type error in one of these parts now reports at its authored position. The build output is unchanged.
