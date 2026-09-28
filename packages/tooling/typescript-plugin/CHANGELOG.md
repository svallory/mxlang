# @mxlang/typescript-plugin

## 0.1.0 (unreleased)

### Fix: `compileWithDependencies` iterates to a fixed point instead of stopping after one retry (compile-with-dependencies-nesting-limit)

`compileWithDependencies` (`src/language.ts`) used to run at most one retry: the first pass used the sources of the previously reported dependencies, and a changed dependency set triggered exactly one more pass. A dependency chain deeper than that — a callee's `AttrTag<Alias>` (the whole type argument) itself aliasing a type `import type`-ed from a further file, which `readCalleeInput`'s own `resolveNamedType` follows across files independently of this loop — could have its deepest hop discovered only by the retry's own compile, with no further pass to read it fresh. The caller then stayed typed against that file's stale or absent text.

`compileWithDependencies` now loops until a pass reports the same dependency set as the pass before it, or a newly reported dependency has no host text different from what a previous pass already read for it, accumulating every pass's sources rather than replacing them — capped at 8 passes (`MAX_COMPILE_PASSES`) so a dependency cycle (A depends on B depends on A) or a pathological chain still terminates. The existing single-hop semantics are unchanged: no reader still means one compile, and a host holding nothing new for a changed dependency set still stops without a retry.

Measured: the nested-field-reference attribute-tag shape (`AttrTag<{ attrs: Alias }>`, as opposed to `AttrTag<Alias>`) is not subject to this at all — that type is never added to `ctx.dependencies`, and is instead resolved entirely through the emitted `satisfies NonNullable<Parameters<typeof Callee>[0]["tag"]>` reference, which TypeScript's own live module graph re-checks on every edit (decision 107, option A) regardless of this function.

### Internal: shared `sourceBindings`/`SOLID_BUILTIN_TAGS` with `@mxlang/parser` (decision 114)

`language.ts`'s `sourceBindings` and `SOLID_BUILTIN_IMPORTS` (used by `appendSolidBuiltinImport`, the synthetic-import injector for Solid's virtual code projection) moved to `@mxlang/parser` as `sourceBindings`/`programBindings` and `SOLID_BUILTIN_TAGS`, now also used by `@mxlang/solid`'s tightened `isComponent` (decision 114) — one implementation instead of two that could drift. No behavior change here; `appendSolidBuiltinImport`'s own contract is unchanged.
