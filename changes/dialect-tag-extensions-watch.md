---
packages: [targets, language-server]
kind: Fixed
---

The language server watches a dialect's `tagExtensions` even when no claimed extension ends them (`.concept` beside a dialect that claims `.probe`), so a change to such a tag file re-checks the dialect files that call it. `@mxlang/targets/dialect-check` gains `dialectWatchExtensions` and `dialectWatchExtensionsUnder`, which add `tagExtensions` to the claimed extensions; `dialectExtensions` and `dialectExtensionsUnder` keep listing only what a dialect claims, since they decide which files a TypeScript program or the Vite plugin treats as sources.
