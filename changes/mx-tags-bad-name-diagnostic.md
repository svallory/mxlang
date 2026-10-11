---
packages: [core]
kind: Fixed
---

A badly named tag file in an MX `tags/` directory (or an `mx.tags` directory) no longer aborts the whole scan. `scanCustomTags` and `discoverProjectTags` used to throw `` `-x` is not a usable tag name ``, so one stray file broke every file in the package. The scan now records the same diagnostic a dialect's `tagDirs` gives for that name: an error with code `MX_INVALID_TAG_FILE_NAME`, at the file's `1:0`, reading `` `tags/-x.mx` is skipped: `-x` is not a usable tag name; a tag file's name must start with a letter, digit or underscore and may then contain letters, digits, underscores, hyphens and dots ``. The bad file is skipped and the other tag files are still discovered. A bad sidecar name (`-x.tag.ts`) is reported the same way. A tool that surfaces `ScanDiagnostic`s shows it with no change; a caller that caught the throw to detect a bad name should read `scan().diagnostics` instead.
