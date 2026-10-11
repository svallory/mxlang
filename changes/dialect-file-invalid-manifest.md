---
packages: [targets, language-server]
kind: Fixed
---

A dialect file in a project whose dialect manifest is invalid (a bad `tagDirs`, say) is still taken for a dialect file, and shows the manifest's error. `dialectExtensions` lists the extensions an invalid manifest names, so `checkDialectFile` no longer returns nothing for the file: the error is reported at the head of the file with the manifest's real place in `origin`, and the language server also publishes it on the `package.json` at the offending field, as it already did when the error was reached through an `.mx` file. `emitOf` reports such a file as unsettled instead of throwing the manifest error.
