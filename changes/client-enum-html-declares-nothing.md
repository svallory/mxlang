---
packages: [html]
kind: Fixed
---
On the html target, `client export enum E { … }` and `client export const enum E { … }` (block or block-less) now declare `E`, so a template that reads it sees `undefined` instead of a ReferenceError, as on stock Marko. A `declare` enum and an unexported `client const enum` still declare nothing, as on stock. An unexported plain `client enum E { … }`, which stock Marko refuses to compile, declares `E` like the exported form.
