---
packages: [core, language-server, tsc]
kind: Fixed
---
Positions in `package.json` and YAML config diagnostics count a lone CR, CRLF, U+2028 and U+2029 as line breaks (TypeScript's rule), and a host-policy diagnostic now carries the UTF-16 `offset` of its position. `mx-tsc` and the language server place it from the offset, so U+2028, which LSP does not treat as a line break, lands on the right line in editors.
