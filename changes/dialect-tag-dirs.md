---
packages: [core]
kind: Added
---

A dialect can declare where its tags live. `package.json#mx.dialect` takes four optional fields (`@unstable`): `tagDirs` (the directory names a dialect file discovers tags in, at each level up to the package root, as `tags/` is for MX), `tagExtensions` (extra extensions its tag files use, routed like `extensions`: the longest suffix wins, two dialects claiming one is the clash error, and `mx.extensions` settles it), `sidecars` (whether `<name>.tag.ts` sidecars index there, on by default) and `reservedTags`. Each field's errors are positioned at its key. Core is dialect zero: an MX file discovers `tags/`, with `.mx` templates and sidecars, exactly as before, and a dialect without the new fields scans exactly as before too.

A dialect file discovers its own `tagDirs`: files ending in a claimed extension, named by the basename minus the longest claimed suffix, plus sidecars. `mx.tags` and `mx.contracts` serve it as they serve an MX file. A bad file name in a dialect tag directory is a positioned diagnostic and the file is skipped (MX `tags/` keeps its error). A dotted name gets a warning naming the `tagExtensions` entry that would fix it, and a sidecar in a dialect with `sidecars: false` gets a warning. MX's own scan skips a file a dialect with `tagDirs` claims, and warns when that file sits outside the dialect's directories (`tags/money.mesh.mx is a Mesh file in tags/; Mesh discovers tags in components/`). `ScanDiagnostic` gains `severity` and `code` (`@unstable`), and `DiscoveredTag` gains `tagFile` and `dialect`.

Until a dialect can read its tag files, a call to such a tag is a `MX_TAG_FILE_ERROR` at the call (`` `<money>` is defined by components/money.mesh.mx, but dialect `mesh` has no tagFile hook to read it. ``). A file that never calls the tag compiles clean.

`scanCached` keys on the caller's dialect too, and also watches every project dialect's `package.json`. A cache hit now stats each tracked file (mtime, ctime, size, inode) and hashes only files changed within three seconds of the snapshot (a sidecar's hash is of the bytes the scan read). A warm hit at 1200 tags drops from about 8.7 ms to 2.2 ms.
