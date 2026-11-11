---
packages: [core]
kind: Fixed
---
Core's compile helpers no longer carry state across compiles in one process: the template-metadata cache is owned per target lookup, the callee-input resolver ids per lookup partition, and the unstamped contract signature is a per-result token instead of a process-wide counter.
