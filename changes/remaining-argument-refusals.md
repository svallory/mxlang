---
packages: [core]
kind: Fixed
---
Tag arguments that were silently dropped are now refused, as Marko 6.4.4 refuses them. A named custom tag takes one plain argument: `<Panel(a, b)/>` fails with "Tag does not support multiple arguments." over the second argument through the last, and `<Panel(...xs)/>` fails with "Tag does not support spread arguments." over the spread, in tag and concise form. The built-in `<id>`, `<log>`, `<lifecycle>` and `<debug>` take no arguments: `<log(x)/>`, `<id(x)/y/>`, `<lifecycle(a, b)/>` and `<debug(x)/>` fail with "Tag does not support arguments." over the argument list, where they used to compile with the arguments dropped. An empty `()` is still accepted on every tag, as in Marko, so `<id()/y/>` and `<button ()>` compile. A `<define>` call and a dynamic tag keep accepting several or spread arguments, which Marko accepts there too.
