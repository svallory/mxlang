---
packages: [core]
kind: Added
---

The IR records every name a tag-param list binds, from Babel's binding analysis: `bindings` on a `Block` (a tag body or an attribute tag's block), on a `DelegatedTag`'s tag and on a `Define`, as `For.bindings` already did. `IR_VERSION` is 11. Core fills it: `[]` with no params, and for a block a custom-tag hook builds, from a parse of its param text; it is absent only when that text is no param list, and a host treats an absent field as unknown. `paramListBindings(params)` returns the names a param-list text binds (`null` when it is no param list). `rewriteCodes`, and with it `rewriteAccessorReads`, shadows those names inside the body they scope and not in the tag's own attributes. `freeIdentifiersInProgram(code)` returns the free identifier reads of a TypeScript/JSX program (`null` when it cannot be parsed), so a host checks whether generated code reads a name without scanning its text.
