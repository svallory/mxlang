---
packages: [babel]
kind: Fixed
---
An expression with many block comments on one line now parses in linear time: the fork's `skipBlockComment` counts line breaks inside the comment only, instead of scanning to the next line break after it.
