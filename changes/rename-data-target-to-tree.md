---
packages: [core, target-registry, data]
kind: Changed
---
**BREAKING (decision 187):** the registered target name `"data"` is now `"tree"`: `mx.target: "tree"` selects it, a third-party host declares `builtOn: "tree"`, and every diagnostic names `tree`. The literal `"data"` is reserved for the future evaluated tree target and is refused with a positioned error (`"data" is reserved for the evaluated tree target (decision 187); the static tree target is "tree"`), under `mx.target` and `builtOn` alike. `mx.data.*` config is unchanged — including `defaultTag` (`mx.tree.*` is read by no tool) — and the package name stays `@mxlang/data` (`parseData` keeps its name).
