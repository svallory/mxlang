---
packages: [tsc]
kind: Fixed
---

`mx-tsc` no longer crashes with an uncaught `EPIPE` when the reader of its output closes early (`mx-tsc --help | head -1`), on Node or on Bun: the rest of the output is dropped and the run exits with tsc's own code, as plain `tsc` does.
