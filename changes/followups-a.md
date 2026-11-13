---
packages: [core]
kind: Fixed
---

A dialect expression row in a module statement (`static`, `server`, `client`, `export`) is now found as the template finds it: a match its matcher stops short of before non-ASCII word characters (`~a-é` under an ASCII matcher) is no row, and a row naming a node type is asked to claim the text, so a row whose `parse` declines is plain source and a `ctx.fail` in its `parse` is the dialect's own error in place of `MX_INVALID_TRIGGER_USE`. Before, both were refused as rows.
