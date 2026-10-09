---
packages: [core]
kind: Changed
---
No behaviour change; lowering retyped to the MX AST for module statements and its own signature (parser port PR 4, slice 6). An `MxModuleStatement` (`import`, `export`, `static`, `server`, `client`, `class`) lowers exactly where Marko's statement tag did, by its keyword. A statement is a statement because of its node kind, not because it has `rawValue`. Its IR `end` comes from `untrimmedEnd`. The internal walk takes `readonly MxChild[]`. `lower` and `lowerChildren` are published as `readonly Node[]`, which accepts everything the old `Node[]` did. New, MX path only: a child-level `MxTrigger`, `MxBlockTag` or `MxFilter` fails, positioned, with the syntax pre-pass's "has no lowering yet" wording (decision 182). An offset-only error about another file (`TranslateError.file`) is no longer positioned against the file being compiled.
