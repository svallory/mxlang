---
packages: [core]
kind: Fixed
---
A nested attribute tag is now lowered in the scope around the call, outside its parent attribute tag's params, as in stock Marko. A read in a nested attribute tag (an attribute value `<@sub y=x/>`, a param default `<@sub|v = x|>`, a type argument `<@sub<x>>` or its body `${x}`) of a name that only the parent's params bind (`<@item|x|>`) no longer counts as bound by them, so when two or more nested bodies declare that name the read is a compile error on every host, as in stock: `` Ambiguous reference, variable was defined in multiple places and was not shadowed. `` (`MX_INVALID_TAG_VAR`). The emitted code already evaluated the nested tag outside the parent's `content` closure, so such a read threw a `ReferenceError` when it ran. A nested attribute tag's own param and the parent's own body still bind the name.
