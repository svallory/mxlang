---
packages: [core]
kind: Added
---
`Dialect.stripTypes` (`@unstable`): a dialect's default for `lowerSource`'s `stripTypes` option, like `structural`, `imports` and `unknownTags`. A call that states `stripTypes` wins; absent means `true`. The tools (`mx-tsc`, the language server, the TypeScript plugin) pass no `stripTypes`, so a dialect whose front end lowers with `stripTypes: false` now gives its hooks the same nodes in the editor as in its build. A value other than a boolean fails the dialect at load.
