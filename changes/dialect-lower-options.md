---
packages: [core]
kind: Added
---

A dialect can state how strictly its files are checked: `structural`, `imports` and `unknownTags` (`@unstable`) on the dialect's module are the defaults `lowerSource` uses for the options of the same name when a call leaves them out, for a routed file and for the `dialect` option alike. `imports` defaults to the effective `structural`, as the option does. The tools pass none of these options, so `mx-tsc`, the language server and the TypeScript plugin now check a dialect's files as strictly as its own compiler. A caller's explicit option still wins, in both directions. `.mx` files are unaffected. A value outside the option's set is an error in the module (`` `structural` must be "pass" or "reject" ``), and `UnknownTag.mode` is now the effective mode.
