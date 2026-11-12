---
packages: [core]
kind: Added
---
`withReasonFirst(error)` returns a parse error whose `message` starts with its reason (Babel and Marko wrote an empty first line, then the position, with the reason on the code frame's caret line). The original error is not touched.
