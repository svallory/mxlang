---
packages: [vite-plugin]
kind: Changed
---
The Vite plugin now resolves build strictness from the target descriptor and the project's `package.json`, like the editor tools always did. A build that compiled `<let>` (or other strict-rejected constructs) under the astro host or with `mx.strict: true` now fails with `MX_UNSUPPORTED_CONSTRUCT`, matching what the editor flags. Astro pages compile under the astro target's always-strict policy, so the fix is to remove or replace the construct (`<const/…>` instead of `<let>`). In a project that opted in with `mx.strict: true`, remove the construct or drop `mx.strict: true`. An explicit `strict: true` plugin option still adds strictness; `strict: false` cannot turn off strictness the resolved policy demands.
