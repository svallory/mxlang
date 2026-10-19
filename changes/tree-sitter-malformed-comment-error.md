---
packages: [tree-sitter-mx]
kind: Fixed
---

Report unterminated content comments as tree-sitter ERROR nodes instead of silently dropping the malformed tail, including comments after a concise tag's semicolon. Completed preceding siblings remain intact, and parsing continues normally after a comment terminator.
