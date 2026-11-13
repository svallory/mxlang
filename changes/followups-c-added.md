---
packages: [core]
kind: Added
---

A `Define` IR node now carries `paramNodes`, the parser node of each param (one per `params` entry, `[]` with none), as `For` already did; it is optional on the type so a hand-built define keeps compiling. `freeIdentifiersInProgram` takes an optional `{ jsxTagNames }`: with `false` a name read only as an element's tag (`Show` in `<Show>`, `Foo` in `<Foo.Bar/>`) is left out; the default keeps today's result. `IR_VERSION` is 14.
