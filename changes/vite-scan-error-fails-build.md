---
packages: [vite-plugin]
kind: Changed
---

An error-severity tag-scan diagnostic fails `vite build`, as a compile error does: a reserved name in a tag file, an `mx.tags` entry or an `mx.contracts` key (`MX_RESERVED_TAG`), or an unusable tag-file name in a dialect's tag directory (`MX_INVALID_TAG_FILE_NAME`). The build error is positioned at the first scan error as `FILE:LINE:COLUMN: CODE: message`, carries the other scan errors in its message, and the scan's warnings are still printed first. Every file compiled in the project fails, not only the first. Under `vite serve` the diagnostic stays a positioned warning, and a warning-severity scan diagnostic stays a warning in both modes. Before, a build with a broken tag file passed.
