---
packages: [core]
kind: Fixed
---
Two more read sites of a tag variable that two or more nested bodies declare are now refused at the read on every host, as in stock Marko, with `` Ambiguous reference, variable was defined in multiple places and was not shadowed. `` (`MX_INVALID_TAG_VAR`): a default inside a tag variable's pattern (`<const/{a = x}=input/>`, and the same in `<let>` or a call's `/var`), and an attribute tag's type arguments (`<@item<x>>`) or type parameters written after a space (`<@item <T extends x>|v: T|>`). Before, both compiled on every host. A pattern default bound by its own body's declaration, shadowed inside the default, or an object key (`{x: a = 1}`) still compiles.
