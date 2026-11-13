---
packages: [preact]
kind: Changed
---

`@mxlang/host-preact/emitter`: the fourth parameter of `createEmitter` and `createRegionEmitter` is now the set of names local to the body (`scopeLocals(new Set(), [], ir.body)` for a whole template) in place of the shadowed-call set, `RegionSink.claimed` is folded into `root`, and `scopeLocals` is exported. `paramNames` and `shadowedCalls` are deprecated: they remain, built on the IR's binding names, for callers of this subpath.
