---
packages: [tsc]
kind: Fixed
---

The `mx-tsc` CLI no longer crashes with an uncaught `EPIPE` when the reader of its output closes early (`mx-tsc --help | head -1`), on Node or on Bun: from the closed pipe on, every later write to stdout is dropped and the run exits with tsc's own code, as plain `tsc` does. Only the CLI entry installs this; a program that calls `runMxTsc` in process keeps its own stdout behaviour.
