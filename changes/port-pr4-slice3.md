---
packages: [core]
kind: Changed
---
No behaviour change; lowering retyped to the MX AST for tags (parser port PR 4, slice 3): tag names (`MxTagName` static, dynamic and unnamed), the attribute list (comments dropped), the tag variable, arguments, params, type arguments and the child list are read from either AST through `tag-fields.ts`, the MX containers unwrapped with `payloadOf`. Type arguments on an MX tag are refused like Marko's, not dropped.
