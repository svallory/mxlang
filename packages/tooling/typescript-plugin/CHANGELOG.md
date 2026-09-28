# @mxlang/typescript-plugin

## 0.1.0 (unreleased)

### Internal: shared `sourceBindings`/`SOLID_BUILTIN_TAGS` with `@mxlang/parser` (decision 114)

`language.ts`'s `sourceBindings` and `SOLID_BUILTIN_IMPORTS` (used by `appendSolidBuiltinImport`, the synthetic-import injector for Solid's virtual code projection) moved to `@mxlang/parser` as `sourceBindings`/`programBindings` and `SOLID_BUILTIN_TAGS`, now also used by `@mxlang/solid`'s tightened `isComponent` (decision 114) — one implementation instead of two that could drift. No behavior change here; `appendSolidBuiltinImport`'s own contract is unchanged.
