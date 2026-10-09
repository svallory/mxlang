---
packages: [core]
kind: Changed
---
No behaviour change; lowering retyped to the MX AST for families 2 and 3 (attributes and name sugar): attribute values, methods, bound attributes and the default value read from `MxAttribute`, and `#id`/`.class`/`:name` sugar from `MxShorthand` through a pre-pass that never mutates the MX tree.
