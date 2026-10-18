---
packages: [solid, angular]
kind: Fixed
---
`<${D}/>` of a `<define>` now renders the define on Solid and Angular, as Marko 6.4.4 does, where it emitted a name nothing declares (Solid: `D` at module scope, while the define is hoisted under a generated name) or a template reference bound to `ngComponentOutlet` (Angular). Solid points the dynamic tag at the hoisted function, including inside a conditional target (`<${c ? D : "span"}/>`); a loop param or another declaration named like the define still shadows it. Angular renders a bare define through `ngTemplateOutlet` and lowers a conditional target to `@if`/`@else`, each branch by what it names. On Angular a define read any other way in the tag name (`D || Other`, `f(D)`), a define with params, and attributes on the tag are a positioned error that names the fix. A define declared after its read is unchanged on both hosts (Marko refuses it too).
