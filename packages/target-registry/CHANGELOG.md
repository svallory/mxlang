# @mxlang/target-registry

## Unreleased

- **Changed (preact-region, decision 154):** the built-in table has a third region kind, `preact` (`.preact.mx`, from `@mxlang/preact`, registered before `react`); `regionFileKinds()`, `moduleSegments()` and every derived list (Vite default extensions, LS language ids, TS plugin per-kind plugins) include it. A `*.preact.mx` file is no longer a whole-file `.mx`.

- **Changed (react-region, decision 154):** the built-in table has a second region kind, `react` (`.react.mx`, from `@mxlang/react`); `regionFileKinds()`, `moduleSegments()` and every derived list (Vite default extensions, LS language ids, TS plugin per-kind plugins) include it.

- **Added (bridge-host, decision 154):** a file kind is a region kind because it has a `compileRegion`, not because its segment is `solid`: `builtinFileKinds` derives `pipeline: "region"` from it, and `regionFileKinds(lookup?)`, `regionFileKind(file, lookup?)` and `regionCompileFor(file, options)` route a `.<segment>.mx` file to its host's region entry through any lookup, `lookupFor(policy)` included. An unregistered `.<word>.mx`, and a file kind without a region entry, are never region files. `regionKindCompile(kind, options)` is the same hook for a kind already in hand (the TS plugin's per-kind plugins).

- **Fix (default-tag-contracts r3):** a target's declarations decide whether contracts may declare `defaultTag`, host or not: a target with no host that forbids it is refused too (naming the target), and a host whose declarations permit it is no longer refused.

- **Fix (default-tag-contracts r2):** `sl-card` is accepted as `mx.<target>.defaultTag` and as a contract value on solid-jsx, preact-jsx, react-jsx, hono-jsx and angular-template, and refused on html, astro-html (Marko rejects an unresolved dashed tag there) and data.

- **Fix (default-tag-contracts r2):** the contract registration check honours a host whose declarations forbid the rung; a library's contract is judged by the consuming compile's tags and reported at the library's declaring module.

- **Added (default-tag-contracts, decision 145):** `resolveTargetPolicyDetailed` checks every contract `defaultTag` once per package at the file that declares it (the contracts module or the sidecar): the shared reasons (not reachable, not an element of the target, not a plain tag), or a refusal naming the host (or the target, when it has no host) when the target's declarations set `allowContractDefaultTag: false`.

- **Fix (default-tag-ladder r3):** `solid-jsx` (and `.solid.mx`) and third-party targets without declarations reject Marko core tags as `defaultTag`; a malformed `mx.contracts` beside `defaultTag: "input"` is the void-tag error, and only the scan is tolerated.

- **Fix (default-tag-ladder r2):** a failing scan never escapes `resolveTargetPolicyDetailed`; on data, reachable means `object` plus the custom tags (html's elements are no data tags); a loaded descriptor's own `defaultTag`/`host.defaultTag` are checked against the target's lookup; `defaultTagFor(file, policy)` takes the resolved policy; `resolveTargetPolicy` accepts the options.

- **Added (default-tag-ladder, decision 145):** `effectiveDefaultTag` (config, then host override, then target built-in), `defaultTagFor(file)` (the same for the target the file compiles under, so a `.solid.mx` reads `mx.solid-jsx.defaultTag`) and the one `invalid-default-tag` error: `resolveTargetPolicyDetailed` checks the package's value once per package, at its `package.json` position, even when no file uses the shorthand (not a tag reachable from the package, or a void, text, statement, control-flow or whitespace-preserving tag, read from the target's Marko lookup). A rejected value is dropped so the built-in answers. A loaded third-party descriptor's own values are checked at its `mx.target` value; `{ quiet }` skips the deprecated-alias warning. `mx-tsc`'s data check passes `mx.data.defaultTag` through and treats `defaultTag` as a known `mx.data` key.

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
