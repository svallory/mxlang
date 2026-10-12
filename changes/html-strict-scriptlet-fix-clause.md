---
packages: [html]
kind: Changed
---

In strict mode, a `$ let` or `$ var` scriptlet now says what to write instead. The error used to stop at "scriptlets (`$ statement`) are not supported in MX"; it now adds "declare a value with `<const/x=…/>` (this strict policy rejects `<let>`, which is reactive state)", naming the declared variable, and a `$ let x = ;` that fails to parse gets the same clause. Strict mode rejects `<let>`, so `<const>` is the form that compiles. The error code, line, column and end are unchanged, and so is the default policy's text.
