---
packages: [language-server]
kind: Fixed
---

The language server publishes the union of the diagnostics against one URI instead of letting the last publish win. A tag file open in the editor keeps the diagnostics the documents that call it raise on it (and the other way round), and two callers raising the same diagnostic show it once. The union shrinks as it should: a caller that is fixed, edited or closed removes only its own part, and the file's own diagnostics changing leave the callers' parts alone.
