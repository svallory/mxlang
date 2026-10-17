---
packages: [angular]
kind: Fixed
---
A static class on an MX tag call whose callee declares a `class` input no longer lands on the callee's host element as well. `<Card class="lit"/>`, `<Card.a/>` and the concise forms gave the callee's `class` input `"lit"` / `"a"` and also set `class="lit"` / `"a"` on the callee's host element; a dynamic `class=` reached only the input, and in Marko 6.4.4 the class appears only where the callee prints `input.class`. A static class now goes to the input alone, as a string, with a shorthand merged into it (`<Card.a class="lit"/>` is `"a lit"`). A callee without a `class` input keeps the class on its host element, and classes a directive or the callee's own `host: {class}` put on that element are untouched. The Angular lowering docs now say to type a callee's `class` input `unknown`: it receives whatever the caller wrote (a string, an array, an object), and `class?: string` fails under `strictTemplates` with TS2322 for `<Card.a class=y/>`.
