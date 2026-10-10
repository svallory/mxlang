---
packages: [core, vite-plugin, target-registry, html]
kind: Changed
---

Building a file calls its dialect's emit, for MX's own files too. Core is dialect zero: its emit is the compile `.mx` and `.<host>.mx` files get, run under the target the tool builds for. `@mxlang/core` exports `emitFor(filename, { hostSegments })` (`@unstable`), which routes a file and answers its dialect and its emit, and the Vite plugin and the `@mxlang/target-html/bun` loader build every file through it and nothing else, so no tool picks a target for a dialect. A plain `.mx` file builds byte-identically in both. A dialect has no emit: Vite's refusal keeps its text and position (`<dialect name> files cannot be imported: the dialect registers no emit`, at the import, or at the head of the file for an entry), and the Bun loader now refuses a dialect's `.mx` file the same way, as a `TranslateError` at line 1, column 0, where it used to compile it as MX.

Not routed through `emitFor`: the Angular CLI, the Astro plugins and the html library API, which build for their own host.
