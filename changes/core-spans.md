---
packages: [core]
kind: Fixed
---
Core diagnostics: the `<effect>` "Rename to `<script>`" fix is offered only when the renamed `<script>` is accepted; the repeated-attribute-tag range of a `for` ends at its name in an indent dialect; a lone CR, CRLF, U+2028 and U+2029 count as one line break in `package.json` and YAML config positions. New `withReasonFirst(error)` returns a parse error whose `message` starts with its reason (Babel/Marko wrote an empty first line, then the position, with the reason on the code frame's caret line).
