---
packages: [core]
kind: Added
---

A dialect can ship its own tag vocabulary: `Dialect.contracts` (`@unstable`) is a `ContractMap` on the dialect's module that every file of the dialect is checked against, in its own compiler and in every tool, with nothing for the project to configure. It replaces shipping a dialect's vocabulary through `mx.contracts` or the `customTags` a dialect's front end passes. Each entry is checked once per revision of the module, when the dialect loads; an entry that cannot register fails the dialect with `MX_INVALID_DIALECT_CONTRACT` at `contracts.<name>` in the module (tools report it with `origin`), and the failure stays until the module is edited. Precedence, highest first: core's reserved names and `<try>`, a file-local PascalCase binding, the dialect's contracts named in its `reservedTags` (any other definition is `MX_RESERVED_TAG`), the project's tag files, `mx.tags` and `mx.contracts` (or the caller's `customTags`), then the dialect's other contracts, which a project definition replaces silently. A caller that passes the dialect as its `dialect` option owns the vocabulary, so its `customTags` override every contract. A `.mx` file never sees a dialect's contracts. `mx.contracts` is unchanged and remains the way to ship a vocabulary for `.mx` files.

A dialect's manifest can set `mxConfigTags: false` (`@unstable`, default `true`) so its files ignore the project's `mx.tags` and `mx.contracts`; tag files (`tags/`, or the dialect's `tagDirs`) still apply.

The docs page "Writing a dialect package" is now two pages: "Contract packages" (`mx.contracts` libraries for projects) and "Writing a dialect" (a dialect's `contracts`, `mxConfigTags`, `explainUnknownTag` and tag files).
