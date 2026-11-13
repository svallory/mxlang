---
packages: [tsc]
kind: Changed
---

`mx-tsc -b` caches the Angular template pass per project of the build graph, in a sidecar file beside the project's build info (`<tsbuildinfo>.mx-ng.json`). A project's stored template diagnostics are replayed, with no extra program and no Angular checker, only when a SHA-256 key over every input of that answer is unchanged: the build info's per-file hashes, the tsconfig and its `extends` chain, the `.mx` files' text, every `package.json` and MX config file that decides their host and Angular config (or its absence), the `@angular/compiler-cli` and TypeScript the checker resolves, mx-tsc's own code and that of its MX externals, and the projects before it in build order. A no-change second `-b` run is again close to `tsc -b`'s own speed. `-b --force` bypasses and rewrites the stored answers. Nothing is stored for a project whose pass printed an MX compile, host-policy or ambient-types diagnostic or could not check its templates, for a run whose TypeScript pass failed, or for a project without an incremental build info (a non-composite project); those keep running the full pass. Watch mode is unchanged.
