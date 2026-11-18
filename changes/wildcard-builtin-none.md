---
packages: [core]
kind: Fixed
---
Under the `none` tag rules a contract's `children["*"]` now claims core's taglib names (`<let>`, `<lifecycle>`, `<await>`, `<id>`, `<log>`, …) and names a host has a row for, as it claims any ordinary name, on every entry (`compileSource`, `lowerSource`, the fragment entries). Before, it refused them as built-in tags. Reserved names and `lowerSource`'s `object` are still never claimed, and outside `none` nothing changes.
