---
packages: [tsx-bridge, language-server, tree-sitter-mx]
kind: Changed
---

- tsx-bridge: publish-ready at `0.1.0-alpha.1` (was private `0.0.0`), because
  the beta's `@mxlang/angular` depends on it. Adds an `exports` map resolving
  from `dist`, `publishConfig.access: public`, repository metadata, a LICENSE
  and a CHANGELOG. The exports are unchanged.
- language-server: marked `private`; it is outside the beta and on no registry.
- tree-sitter-mx: the CHANGELOG heading for `0.1.0-alpha.2` carries its
  publish date (2026-10-05) instead of "unreleased".
