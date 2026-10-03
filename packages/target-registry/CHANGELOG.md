# @mxlang/target-registry

## Unreleased

- **Added, unstable (target-registry, decisions 129 and 132):** new private package. `builtinTargets` (the seven built-in target descriptors: `html`, `astro-html`, `solid-jsx`, `preact-jsx`, `react-jsx`, `hono-jsx`, `angular-template`), `builtinTargetLookup` (`createTargetLookup` over them, with `astro-template` reserved), and `BuiltinFileKind` / `builtinFileKinds` (core's `HostFileKind` plus the registry-private editor `pipeline`). Importing it loads no `@marko/compiler` and no `@astrojs/compiler`. Nothing consumes it yet. `data` joins with `@mxlang/data`.
