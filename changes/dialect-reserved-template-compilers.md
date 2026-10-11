---
packages: [core]
kind: Changed
---

`compileSource` and `parseFragment` now throw `MX_RESERVED_TAG` for a `customTags` entry that names one of the routed dialect's `reservedTags` (`` `<name>` cannot be defined by `customTags`: <Dialect> reserves it ``), as `lowerSource` already reports it. This applies whether or not the dialect has `contracts`, and whether or not the file calls the name. Before, such a file compiled with the caller's definition. A caller that passes the dialect as its `dialect` option still owns the vocabulary, so its `customTags` are never refused for a dialect's reserved name.
