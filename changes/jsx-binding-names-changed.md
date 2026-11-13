---
packages: [preact]
kind: Changed
---

`@mxlang/host-preact/emitter`: the fourth parameter of `createEmitter` and the fourth of `createRegionEmitter` take the set of names local to the body (`scopeLocals(new Set(), [], ir.body)` for a whole template). The `WeakSet` of calls `shadowedCalls(ir)` returns is still accepted there with its old meaning (a call in it keeps its authored name, every other define call reaches the private function) and is deprecated. `RegionSink.claimed` is folded into `root`, and `scopeLocals` is exported. `paramNames` and `shadowedCalls` are deprecated: they remain, built on core's binding analysis, for callers of this subpath.
