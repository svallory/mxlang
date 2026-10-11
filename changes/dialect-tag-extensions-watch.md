---
packages: [target-registry, language-server, typescript-plugin, tsc]
kind: Fixed
---

A dialect's `tagExtensions` entry that no claimed extension ends (`.concept` beside a dialect that claims `.probe`) is now a dialect file the tools list: `dialectExtensions` and `dialectExtensionsUnder` include `tagExtensions`. The language server watches such a tag file, so a change to it re-checks the dialect files that call it; the TypeScript plugin hosts it; and `mx-tsc` checks it and prints its errors, as it already did for a tag file named `.thing.probe`.
