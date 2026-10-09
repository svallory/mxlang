---
packages: [core, tsx-bridge]
kind: Changed
---

Core's parse-error rewrites (the mismatched-close opener, a failure inside a tag's `|params|`, sugar right after a default value, the atom hints, the shorthand-word probe) replay the source with MX's own template lexer (`@mxlang/parser/lexer`) on every run, never with `htmljs-parser` through `@marko/compiler` (decision 197, PR 6 slice S2). The dist already lexed with MX's parser; running from source now does too. No diagnostic text or position changes. `@mxlang/tsx-bridge` declares the `htmljs-parser` 5.18.0 its region walk bundles, which it used to resolve from the install around it; its output is unchanged. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged (`mesh-syntax.test.ts` passes unchanged).
