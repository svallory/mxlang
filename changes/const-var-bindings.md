---
packages: [core]
kind: Added
---

`Const` IR nodes now carry optional `varBindings`: every identifier the binding pattern declares, with its authored span. Hosts can report collisions in object, array, renamed, nested, default and rest patterns without parsing the pattern again. The IR entry point checks that each binding carries its promised span. This observable IR shape addition advances `IR_VERSION` from 7 to 8; emitted code for valid programs is unchanged.
