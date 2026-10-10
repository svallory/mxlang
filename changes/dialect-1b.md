---
packages: [core]
kind: Changed
---

Dialect routing and MX's config now guard what belongs to MX, to other languages and to the dialect.

- A dialect cannot claim, and `mx.extensions` cannot route, `.mx` in any spelling (`.MX`, `.page.Mx`), a host's file kind (`.solid.mx`, `.ng.mx`: the segments the caller's targets declare, which `compileSource` passes in), or an extension whose last segment is TypeScript's, JavaScript's or Marko's (`.ts`, `.tsx`, `.mts`, `.cts`, `.d.ts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.marko`). Each is an error at `mx.dialect.extensions` or at the `mx.extensions` entry. `.mesh.mx` stays claimable.
- MX's config setting `tagRules`, or `tagRules` or `name` under a dialect's id, is an error at its key: those belong to the dialect. A top-level key that is none of MX's keys, no target's or host's settings block and no discovered dialect's id is an `unknown-config-key` error at its key.
- `compileSource` and `parseFragment` parse a dialect's files under the tag rules the dialect states, as `lowerSource` already did; MX's own files keep their target's rules.
- An installed dialect whose `mx.dialect.module` is TypeScript is an error saying the module must be JavaScript Node can load, and a `module` written as a package specifier is an error saying it is a file path inside the package.
- The reference `syntax/mesh` module states `tagRules: "none"`.
