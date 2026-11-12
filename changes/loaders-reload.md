---
packages: [core, vite-plugin, host-astro]
kind: Fixed
---

Host file kinds match without regard to letter case, as the editor tools already read them: `Card.Astro.MX`, `Card.Solid.MX` and `Card.Ng.MX` are host files in the build too. `hostModuleSegment` returns the lowercase segment for any casing, the Vite plugin matches its extensions on the lowercased name, and the Astro pages guard finds `.astro.mx` pages in any case.
