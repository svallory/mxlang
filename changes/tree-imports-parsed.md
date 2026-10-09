---
packages: [core, data]
kind: Added
---
Each `DataDocument.imports` entry now carries `from` (the module specifier) and `names` (`{ imported, local, kind: "default" | "named" | "namespace" }`, with `typeOnly: true` on a name written `{ type X }`) beside `code` and `span`, plus `typeOnly: true` on a whole `import type`. They are read from the Babel `ImportDeclaration` the MX front end parsed, never from the statement text. To carry it, core's `Import` IR node gains an optional `declaration` (the parsed `ImportDeclaration`, as the author wrote it: type-only marks included, although the compile strips them from the payload before lowering); it is absent on a synthesized import.
