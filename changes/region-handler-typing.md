---
packages: [preact, typescript-plugin]
kind: Fixed
---
A native element's event handler in a `.preact.mx`, `.react.mx` or `.hono.mx` region is now type-checked in the editor and `mx-tsc` as in a whole-file `.mx`: a mismatch against the host's own handler type is reported (TS1360) at the handler, or at a shorthand's attribute name, instead of a TS2322 at an approximate position on the prop. Under `typeCheck` the shared JSX region compile wraps the handler as `(fn) satisfies __MxH<"tag", "event"> as any` and hoists the whole-file type-only preamble into the module once; `createRegionEmitter` (`@mxlang/host-preact/emitter`) takes an optional trailing `handlerType` parameter, the wrapper's type alias.
