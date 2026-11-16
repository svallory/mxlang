---
packages: [solid, angular]
kind: Fixed
---
The Solid and Angular hosts re-parse expressions and statements with MX's Babel fork, so many block comments on one line no longer make their compile passes quadratic.
