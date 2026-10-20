---
packages: [core]
kind: Fixed
---

A namespace with values followed by an enum of its name in one block, when reported as a duplicate binding by the TypeScript strip, now produces a positioned `MX_DUPLICATE_DECLARATION` at the colliding declaration's name instead of a raw positionless internal error. This also covers function and `if` bodies and `tagRules: "none"`. At module or namespace top level the message advises declaring the enum first; in nested statement bodies it advises moving the namespace to module or namespace top level, since reordering alone does not make it loadable under Bun and esbuild. Forms the strip accepts continue to compile, including an enum–namespace–enum merge in one block.
