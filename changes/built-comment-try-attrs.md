---
packages: [core]
kind: Fixed
---
A custom tag's hook that builds an `<html-comment>` or `<try>` with attributes now fails with the tag's no-attributes message instead of dropping them, as the authored tags do.
