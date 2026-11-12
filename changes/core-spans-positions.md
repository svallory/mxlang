---
packages: [core, language-server]
kind: Fixed
---
Positions in `package.json` and YAML config diagnostics count a lone CR, CRLF, U+2028 and U+2029 as line breaks (TypeScript's rule), and a host-policy diagnostic now carries the UTF-16 `offset` of its position. The language server places it from the offset, so U+2028, which LSP does not treat as a line break, lands on the right line in editors. A malformed `package.json` or config is positioned from the parser's `position N` when its message has one, and carries that offset too.
