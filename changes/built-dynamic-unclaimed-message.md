---
packages: [core]
kind: Fixed
---
A custom tag's hook that builds a dynamic tag through `ctx.build.delegatedTag` on a host that does not render one built (Preact, React, Hono, Solid) now names it as a dynamic tag in the "does not claim" error (`` `<widget>`: this host does not claim a dynamic tag (`<${…}>`), so a custom tag cannot emit one ``), instead of printing an internal placeholder inside the tag brackets.
