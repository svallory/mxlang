---
packages: [core]
kind: Fixed
---
Core's template-metadata cache now serves an entry only to a compile under the same tag set, declarations and lookup it was derived under, so a compile's output no longer depends on which compile ran before it. A cached callee Input whose read went through a template's metadata (a .mx callee, or an Input type followed into a .mx file) is reused only under the same tag set and declarations; its resolver ids live in each lookup's partition.
