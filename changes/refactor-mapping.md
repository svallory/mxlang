---
packages: [typescript-plugin]
kind: Fixed
---
A TypeScript refactor or organize imports whose edit lands on a verification-only mapping no longer rewrites authored text it does not describe: the refactor returns no edits (`undefined`) and organize imports returns no changes, as a code fix already did. Before, "Convert to template string" with the cursor in a `.solid.mx` attribute tag's value (`<@tab title=foo.bar + "y"/>`) wrote its result three characters early, over `le=foo.bar`.
