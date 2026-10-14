---
packages: [tsc]
kind: Fixed
---
`mx-tsc --watch` now reports host-policy diagnostics (`TS80003`, such as an `mx.target` that belongs to another host) on every build, the first one included, before tsc's summary line. A policy error is counted in the summary and keeps the exit code at 1 until a build no longer has it; a policy warning is printed and not counted. They used to print once, after the first build's summary and outside its count, and never on a rebuild, so a watcher standing on a bad `package.json` could read as clean.
