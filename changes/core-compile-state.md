---
packages: [core]
kind: Fixed
---
Core's template-metadata cache now serves an entry only to a compile under the same tag set, declarations and lookup it was derived under, so a compile's output no longer depends on which compile ran before it. The callee-input cache key also names the compile's tag set, and its resolver ids live in each lookup's partition.
