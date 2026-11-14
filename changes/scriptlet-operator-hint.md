---
packages: [core]
kind: Fixed
---
A `$` scriptlet continued on a more-indented line (`$ const a = 1 + ` then `  2`) now says that scriptlets are not supported, with the usual replacement, on the "Line has extra indentation at the beginning" error it causes; the error's code and position are unchanged.
