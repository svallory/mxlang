# @mxlang/target-registry

## Unreleased

- **Added (data-cli, decision 131 addendum 4):** `resolveTargetPolicyDetailed(file, { dataWired: true })` answers with the real policy, `data` included, instead of the staged error and `html` fallback (the default for every other caller is unchanged), and the subpath `@mxlang/target-registry/data-check` exports `checkDataPackage(dir)` and `isDataProject(dir)`: `mx-tsc`'s data check, in a module of its own so importing the registry stays light.

- **Added (third-party-target, registration PR 7):** `lookupFor(policy)` (the built-in lookup, plus the descriptor a package specifier under `mx.target` / `mx.host` loaded; cached per descriptor, so its identity is stable) and `descriptorFor(policy)`. The `scanCached` / `getCustomTags` wrappers take an optional `targets` lookup, so a loaded host's name is a valid `mx.tags[].hosts` value. Tools use these in place of `builtinLookup()` wherever a project's policy is in hand.

- **Added (target-select, decisions 129/132 and decision 131 addendum):**
  `mx.target` selection through the built-in policy wrapper. Explicit `data`
  is a positioned error naming `parseData` from `@mxlang/data` and
  `TODO data-target-tooling-dispatch`, with the unknown-target fallback.
  This temporary tooling restriction lives only in the registry, never core;
  dependency-only data staging remains unchanged.

- **Changed (refactor/target-open-set, decisions 129 and 132):** the registry is now the entry point tooling imports: it exports the built-in lookup's own answers (`hasTarget`, `targetNames`, `target`, `defaultTarget`, `fromPackage`, `attrTagSources`, `hostValues`, `hostTarget`, `hostOf`, `hostFilterKey`, `moduleSegments`) and wrappers bound to `builtinLookup()` (`resolveTargetPolicy`, `resolveTargetPolicyDetailed`, `hostModuleSegment`, `scanCached`, `getCustomTags`). The scan wrappers pass the lookup and turn the scan's recorded `mx.tags[].hosts` values into diagnostics, so a bare unknown word still warns with the same text and a package specifier stays silent. Creating the registry also registers every file kind's `readCalleeInput` into core, so a `.solid.mx` callee is probed without importing `@mxlang/solid` for its side effect (the #216 ordering hazard). `parity.test.ts` now pins the rules that core's deleted closed lists encoded.
- **Added, unstable (target-registry, decisions 129 and 132):** new private package. `builtinTargets` initially held seven descriptors, `builtinTargetLookup` was built over them with `astro-template` reserved, and `BuiltinFileKind` / `builtinFileKinds` add the registry-private editor `pipeline` to core's `HostFileKind`. Importing the registry loads no `@marko/compiler` and no `@astrojs/compiler`.
- **Added, unstable (data-pr3):** `builtinTargets` gains `data` (the hostless `@mxlang/data` target, last): eight targets. It has no host, no file kind, no `mx.host` value and no `mx.tags[].hosts` filter key; `fromPackage("@mxlang/data")` is `data`, and `@mxlang/data` joins `attrTagSources()`. Rule 2 now selects it for a project depending only on `@mxlang/data`; the parity tripwire moves with the resolver.
