---
packages: [tsc, language-server]
kind: Fixed
---
`mx-tsc --watch` reports MX compile errors on every rebuild. It used to print them once, after the first build (and under the first build's "Found 0 errors"), so an MX error introduced while the watcher ran, such as `<effect>` or an unclosed tag, produced "Found 0 errors" and no MX line at all. Each rebuild now prints the MX errors that hold after it, with their fix lines, before tsc's summary, and the summary's count includes them; a fixed error is gone from the next rebuild. A one-shot run with an MX error ends with `mx-tsc: Found N MX error(s) (tsc's own error count does not include MX errors).` when tsc printed its own count line, since tsc counts only its own diagnostics. The language server's quick-fix code actions skip a malformed fix (a `null` entry, a `null` edit, a missing `edits` array) instead of throwing on it.
