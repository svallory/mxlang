# @mxlang/target-registry

## Unreleased

- **Added, unstable (target-registry, decisions 129 and 132):** new private package. `builtinTargets` (the seven built-in target descriptors: `html`, `astro-html`, `solid-jsx`, `preact-jsx`, `react-jsx`, `hono-jsx`, `angular-template`), `builtinTargetLookup` (`createTargetLookup` over them, with `astro-template` reserved), and `BuiltinFileKind` / `builtinFileKinds` (core's `HostFileKind` plus the registry-private editor `pipeline`). Importing it loads no `@marko/compiler` and no `@astrojs/compiler`. Nothing consumes it yet. `data` joins with `@mxlang/data`.
- **Added, unstable (data-pr3):** `builtinTargets` gains `data` (the hostless `@mxlang/data` target, last): eight targets. It has no host, no file kind, no `mx.host` value and no `mx.tags[].hosts` filter key; `fromPackage("@mxlang/data")` is `data`, and `@mxlang/data` joins `attrTagSources()`. Today's closed lists (`HOST_NAMES`, `HOST_PACKAGES`, `MX_ATTR_TAG_SOURCES`) do not list it, so the parity tests compare them against the seven hosts and pin the divergence.
