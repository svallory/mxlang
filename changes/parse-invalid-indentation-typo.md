---
packages: [core, parser]
kind: Fixed
---
The parse error for a line whose indentation differs from the previous line's now reads "Line indentation does not match indentation of previous line"; it was missing the "not". Only the message text changes; the code `MX_PARSE_INVALID_INDENTATION` and the position are the same.
