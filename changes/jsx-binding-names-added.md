---
packages: [core]
kind: Added
---

The IR records every name a tag-param list binds, from Babel's binding analysis: `bindings` on a `Block` (a tag body or an attribute tag's block), on a `DelegatedTag`'s tag and on a `Define`, as `For.bindings` already did. `IR_VERSION` is 11. Core always fills it (`[]` with no params); a host treats an absent field as unknown. `rewriteCodes`, and with it `rewriteAccessorReads`, shadows those names inside the body they scope and not in the tag's own attributes. `freeIdentifiersInProgram(code)` returns the free identifier reads of a TypeScript/JSX program (`null` when it cannot be parsed), so a host checks whether generated code reads a name without scanning its text.
