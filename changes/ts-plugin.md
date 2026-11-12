---
packages: [typescript-plugin]
kind: Fixed
---

A malformed `package.json` beside an `.ng.mx` is reported once, as a compile error carrying the manifest's parse position (`mx-tsc` fails the run), instead of an error plus a host-policy warning plus a logged scan warning; with a separate `.mxrc.json` it is the single host-policy warning. Fixing `package.json` or any MX config spelling clears its host-policy warning at the next diagnostics request; a file whose host changed, or whose compile failed on the config, says so until it is edited, and its compiled output updates when it is next edited. `{ astro: true }` resolves `@astrojs/language-server` from the project first, so it works from the VS Code extension. A component prop value the emitter recorded is no longer also mapped to an earlier matching text in the generated module.
