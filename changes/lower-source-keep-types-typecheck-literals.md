---
packages: [core]
kind: Fixed
---
A contract's `type` check and the bound-attribute check (`v:=`) now look through a top-level TypeScript assertion (`as`, `satisfies`, `!`, `<T>x`). In the type-check compile, `<X a=(1 as number)/>` against `a: { type: "string" }` was accepted while the build refused it; both now refuse it, and `v:=(y as any)` is a valid binding in both.
