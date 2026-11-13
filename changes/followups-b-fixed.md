---
packages: [astro, language-server]
kind: Fixed
---

An `.astro.mx` fence default import of a `.mx` file (`import Card from "./Card.mx"`, or an alias that `resolveImport` maps) is now read by core: the callee's `Input` checks the call (for example `MX_UNKNOWN_ATTRIBUTE_TAG` for an attribute tag it does not declare) and the file is listed in `dependencies`; the emitted Astro code is unchanged, and every other fence import is routed as before. The language server records a watcher edge for the callee a `.ng.mx` file reads when the file compiles cleanly, not only when it fails.
