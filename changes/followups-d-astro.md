---
packages: [astro]
kind: Fixed
---

The `.astro.mx` refusal of `/var` on a call to a tag that declares `<return>` is now positioned at the `/var` binding (`<Counter/n …/>` points at the `n`, and its range ends after it) instead of at the tag start; the message is unchanged. `createEmitter` from `@mxlang/host-astro/template` takes an optional trailing `positionOf` to resolve that offset; without it (`emitTemplate(ir)`) the error stays at the tag.
