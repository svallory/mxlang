---
packages: [core, solid, astro, preact, react, hono, angular]
kind: Fixed
---
A file routed to a dialect whose `tagRules` is `none`, compiled through Solid (`compileSolidMx`, `compileSolidUnit`), Astro (`lowerAstroMx`), a Preact, React or Hono region or an Angular `.ng.mx` region, now follows the `none` tag rules as it does on `compileSource`. The host's rows for names that are not reserved no longer apply there (`<lifecycle>` and `<let>`, for example, are ordinary tags; before, `<lifecycle a=1>x</lifecycle>` was refused as `` `<lifecycle>` is not supported in embedded … ``), and core's `let`/`const`/`define`/`effect`/`log` checks are off, while a reserved name's row still applies (`<else/>` alone is still `` `<else>` must follow an `<if>` ``). Lowering adopts the preset of the dialect the parse registered when the caller set none; a caller's own `tagRules` still wins. MX's own files and files of a dialect stating another preset are unchanged.
