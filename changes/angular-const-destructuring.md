---
packages: [angular]
kind: Fixed
---
A `<const>` destructuring pattern (`<const/{ a, b }=obj/>`, `<const/[x, y]=list/>`) compiles on Angular. It emitted `@let { a, b } = obj;`, which Angular rejects, and inside an element body the collision rename produced `@let __mxConst_{ a, b } = …` with the reads unrenamed. A pattern now becomes one generated `@let` that holds the initializer (evaluated once) and one `@let` per bound name reading from it: object fields, renames, string keys, array elements and holes, nested patterns, defaults (applied to `undefined` only, as in JavaScript) and an array rest (`.slice`). Each bound name takes part in the element-body rename like a plain `<const>`, so it keeps the name you wrote unless another declaration or an outside read shares it, and Angular's diagnostics through `@mxlang/angular-checker` print the name you wrote. An object rest (`{ a, ...rest }`) has no template-expression form and is a positioned compile error that names the fix.
