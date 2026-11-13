---
packages: [html, core]
kind: Fixed
---

Type checking a `.mx` page (`mx-tsc`, the editor) now checks each `client` statement in its own scope. Client code reading a `server` name is reported as possibly `undefined`; a template read, a `server` statement or a `static` statement reading a `client` import is reported the same way; a client namespace body reading a server name is reported; and a refinement naming a client function (`value:clamp:=q`) is checked against that function instead of being reported as calling `undefined`. Errors land on the authored token. The module that runs is unchanged. Added in `@mxlang/core`: `moduleStatementNames(ctx)`, the names each module statement (`import`, `static`, `server`, `client`, `export`) declares, by keyword, with the `DeclarationKind` and `ModuleStatementNames` types.
