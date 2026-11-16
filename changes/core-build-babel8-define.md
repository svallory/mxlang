---
packages: [core]
kind: Fixed
---
Core's dist no longer reads `process.env.BABEL_8_BREAKING` at parse time, so setting it no longer switches the bundled parser to Babel 8 behaviour.
