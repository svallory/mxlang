---
packages: [language-server]
kind: Fixed
---

An open document no longer records every scanned `.mx` tag file as a dependency. The scan lists each tag template it finds but never reads one, so only the scan's real inputs (contracts modules, sidecars, the dialect module and dialect tag files) and the templates the compile actually called are tracked. Editing an unused template no longer re-publishes diagnostics for every open caller, and dependency storage no longer grows with open documents times visible tag files.
