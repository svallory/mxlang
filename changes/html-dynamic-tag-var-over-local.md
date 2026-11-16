---
packages: [html]
kind: Fixed
---
A `/var` on a dynamic tag whose target is a local value binds as Marko 6.4.4 does: `<for|V| of=[U]><V/x n=21/>` and a tag param's `<T/x/>` compile instead of being refused, and over a `<define>` that declares `<return>` (`<V/x/>` or `<${V}/x/>`) `x` is the define's `<return>` value instead of `undefined`. A `.ts` or barrel value import called by name (`<Widget/n/>`) now binds as `<${Widget}/n/>` does. The public value a returning `<define>` emits now carries its `{ value, output }` function as a non-enumerable `__mxDefinePair` property, which the dynamic-tag helper reads; `Object.keys` and a spread of the value are unchanged.
