---
packages: [angular]
kind: Fixed
---
An array or shorthand class on an MX tag call now reaches the callee's `class` input the way Marko 6.4.4 passes it to `input.class`. `<Card.a class=y/>` and `<Card.a.${x}/>` handed the callee a joined string (`"a zz"`); when the callee's `Input` declares `class`, it now gets the value as written (`["a", y]`, `["a", "xx"]`, `[y]` for `class=[y]`). A callee without a `class` input is unchanged: the joined class lands on its host element.

A tag module whose `Input` declares `class` is now checked on every parent pass (`changeDetection: Eager`). Angular components default to OnPush, and a tag call assigns `class` as a plain property, so the callee kept rendering the first class it received after the value changed.
