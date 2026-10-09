---
packages: [core]
kind: Changed
---
No behaviour change; lowering retyped to the MX AST for node kinds and spans (parser port PR 4, slice 2): the child dispatch, layout and statement scans accept the MX node kinds beside Marko's, and positions read an MX node's UTF-16 offsets where a Marko node has `loc`. `TranslateError` gains an optional `span` (`SourceSpan`, file offsets): set when the error was raised on an MX AST node, kept after `line`/`column` are filled in from the source.
