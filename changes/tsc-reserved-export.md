---
packages: [html, core, typescript-plugin]
kind: Fixed
---

A `client import` of another `.mx` module's client export through a `.mx` specifier is now typed in `mx-tsc` and the editor instead of reporting `TS2694`: every html type-check module carries a reserved `__mxClientExports` namespace with its module-level exports and its client value exports, and the importer's client view reads it. An unknown name stays `TS2694` at the name, and the module that runs does not change. Added: core's `ModuleStatementNames.exports`, every name a module statement exports as written. Changed: core refuses an export-list or `export * as` name and an import specifier's imported name that start with `__mx`, with the reserved-name error at that name. The TypeScript plugin leaves `__mxClientExports` out of completions, and a failed module's stub declares it too.
