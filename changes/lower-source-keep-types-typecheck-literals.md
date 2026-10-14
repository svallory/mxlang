---
packages: [core]
kind: Fixed
---
Core's checks of an attribute value now look through TypeScript assertions (`as`, `satisfies`, `!`, `<T>x`, `x<T>`), so a value written `(1 as number)` is checked as `1`. This closes the gap where the type-check compile accepted `<X a=(1 as number)/>` against `a: { type: "string" }` while the build refused it; the same goes for a contract's `number`, `boolean`, `enum`, `literalOnly`, `array`, `items`, `function` and `atom` checks, and the bound-attribute check accepts `v:=(y as any)` and refuses `v:=(1 as any)` in both.
