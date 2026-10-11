---
packages: [vite-plugin]
kind: Changed
---

An error-severity tag-scan diagnostic (a tag file named after a reserved name, `MX_RESERVED_TAG`, an invalid contract entry) fails `vite build`, as a compile error does, with the message `FILE:LINE:COLUMN: CODE: message` positioned at the offending file; every file compiled in the project fails, not only the first. Under `vite serve` it stays a positioned warning, and a warning-severity scan diagnostic stays a warning in both modes. Before, a build with a broken tag file passed.
