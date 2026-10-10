---
packages: [angular]
kind: Fixed
---
Body content on a `<define>` call (`<Row(1)>body</Row>`) is now a positioned error at the call tag instead of compiling with the body silently dropped: the Angular target projects a `<define>` call through `ngTemplateOutletContext`, a positional argument object, and has no channel for a content fragment the way Marko appends a trailing `{ content }` object. The message says to pass the value as a tag argument instead, `<Row(...)/>`. A call with no body (self-closing or with an empty closing tag) compiles exactly as before.
