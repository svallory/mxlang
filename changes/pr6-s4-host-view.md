---
packages: [core]
kind: Changed
---

No user-visible change. Core now builds, internally, a plain-data view of a tag and its attributes for host hooks to receive later; nothing new is exported and no hook receives it yet. No diagnostic text or position changes. `parseData` output and the `DataTag`/`DataAttr`/`DataExpr`/`DataImport` types are unchanged.
