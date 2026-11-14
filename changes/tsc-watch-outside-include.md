---
packages: [tsc]
kind: Fixed
---
`mx-tsc -w`: a `.mx` module imported through tsconfig `paths` (`import Card from "~/Card.mx"`) that is created or moved into a directory outside the tsconfig `include` now clears the caller's TS2307 on the next rebuild; before, the error stayed until the watcher was restarted. In `-w` (not `-b`), imports of plugin-extension files also go through TypeScript's watch resolution cache, so their failed lookups are watched.
