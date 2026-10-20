---
packages: [core]
kind: Fixed
---

A page that calls or imports a tag template whose source uses tag type arguments or parameters (`<p<string>>`, `<define/Foo<T>>`) no longer fails to build with "type arguments on `<p>` are not supported in a standalone template".
