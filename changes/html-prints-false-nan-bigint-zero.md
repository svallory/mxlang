---
packages: [html]
kind: Fixed
---
`${…}` and `$!{…}` in text position now print what Marko's html runtime prints. A truthy value prints as its string, `0` (and `-0`) prints `0`, and every other falsy value (`false`, `NaN`, `0n`, `""`, `null`, `undefined`) prints nothing. The html target used to print `false`, `NaN` and `0` (for `0n`), and `$!{…}` printed `null` and `undefined`. Attribute values are unchanged: `false`, `null` and `undefined` still drop the attribute, and `NaN` and `0n` still print. The compiled module now carries a small inlined `__mxTextOf` helper wherever a template prints a placeholder; the runtime import is still `escape`, `createOut` and the sink types.
