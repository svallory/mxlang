---
packages: [targets, language-server]
kind: Added
---

The tools show a dialect file's tag-discovery diagnostics with their severity, code and file. `checkDialectFile` keeps a scan diagnostic's `severity` and `code` (`MX_MISPLACED_TAG_FILE` was always a warning with no code, a scan error always an error with no code), and a diagnostic measured in another file (a tag file's own error, `MX_TAG_FILE_CYCLE` found in a second tag file, a manifest or contracts module) carries `origin: { file, line, column }`, the real place, while it stays at the head of the checked file so no tool paints it at the wrong offsets. The language server publishes such a diagnostic on its own file at its real range and leaves a pointer with `relatedInformation` at the head of the dialect file, and sets `code` on the scan warnings it shows for an MX file (`MX_MISPLACED_TAG_FILE`).
