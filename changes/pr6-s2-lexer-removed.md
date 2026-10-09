---
packages: [core]
kind: Removed
---

`markoHtmljsParser()` and its type `HtmljsParser` are no longer exported from `@mxlang/core` (decision 197, PR 6 slice S2); nothing inside or outside core called them. A tool that needs MX's template lexer uses `@mxlang/parser`'s.
