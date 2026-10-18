---
packages: [core]
kind: Added
---
A dialect node type can name itself for its users. `NodeType` has an optional `label` (`label: "atom"` on `mesh:Atom`), and core's contract messages show it in place of the registry key: `option mode must be atom, got string` and `must be array, got atom` instead of `... mesh:Atom ...`. It covers the type a slot asks for and the type of the value written, for node-type slots, lists of nodes, and a node written against a string, number, array, function or enum slot. A type without a label shows its key and every message is unchanged. A label that is not a non-empty string fails the dialect at load (`MX_INVALID_DIALECT_MODULE`), naming the dialect and the type. Messages to the dialect's own author (registration, row and hook errors) keep the key. The `is not a node type field` message now lists `label`.
