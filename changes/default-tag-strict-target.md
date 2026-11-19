---
packages: [core]
kind: Fixed
---
The `defaultTag` check a dialect tag file's derived contract gets at its call now uses the compile's own target when that target compiles under its strict declarations (`declarations.strict`), instead of the lookup's default target. Before, such a compile took the default target's `defaultTag` as the built-in and named that target in the refusal, so a target that was not the lookup's default reported ``invalid `defaultTag` value: `<bnode>` is not a tag reachable from this package`` for its own `defaultTag`. In-repo targets see no change in output.
