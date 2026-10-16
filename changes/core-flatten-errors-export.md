---
packages: [core]
kind: Added
---
`flattenErrors(error)` is exported from the package entry (`@unstable`): the errors a thrown value stands for. A `TranslateError` gives its `errors` list, a `CompileErrors` aggregate from a parse with several syntax errors gives its errors in the order core found them (a cause before the missing end tag it leaves), and anything else (or an error whose list is empty) gives itself, so a thrown error is never zero diagnostics. A tool that turns a thrown compile error into diagnostics calls it first, so it reports every error of the file.
