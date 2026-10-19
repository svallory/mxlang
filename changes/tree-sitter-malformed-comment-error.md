---
packages: [tree-sitter-mx]
kind: Fixed
---

Report unterminated content comments as tree-sitter ERROR nodes instead of silently dropping the malformed tail, including comments after a concise tag's semicolon. With one error in a parse, completed preceding siblings stay intact and parsing continues normally after a comment terminator; a second error in the same parse ends it (root ERROR, earlier siblings inside it), as it already did for a concise `-` line and for `<!--`. An unterminated comment or template inside a template literal in parsed text is still not reported as an ERROR.
