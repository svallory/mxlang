---
packages: [core, language-server]
kind: Fixed
---

A dialect tag file an editor has open is read as the editor has it, so an unsaved fix to it clears the errors it caused on the files that call it (and an unsaved break raises them) before anything is saved. Core read the tag file from disk, so the caller's `` `<money>`'s definition has errors `` stayed until save, though an unsaved `.mx` template already reached it through `withCalleeInputSources`; the dialect's `tagFile` hook now gets that same text, and a contract derived from unsaved text is kept only while that text is in force, and one derived from the disk only while no unsaved text is. The language server re-checks the callers when such a document is closed, so an unsaved change that is discarded stops counting.
