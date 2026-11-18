---
packages: [core]
kind: Fixed
---
Under the `none` tag rules, the `defaultTag` check (the one a dialect tag file's derived contract gets at its call, and the use-site check an unnamed tag's parent contract gets) now counts only the reserved names (`if`, `const`, `try`, …) as core vocabulary: core's other taglib names (`<let>`, `<await>`, `<script>`, …) are judged as ordinary names, so ``defaultTag: "let"`` reads `` `<let>` is not a tag reachable from this package `` as `nope` does instead of `` `<let>` is a void tag ``, and on a host that compiles an unknown dashed name as a native element `html-script` is a valid default tag. The check also uses the compile's own target under a preset, so that target's `defaultTag` and host's `defaultTag` count as built-in tags and a refusal names that target's host, not the lookup's default target's. Outside `none` nothing changes.
