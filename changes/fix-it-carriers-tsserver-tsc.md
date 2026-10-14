---
packages: [typescript-plugin, tsc]
kind: Added
---
A diagnostic's quick fixes now reach tsserver and `tsc`. The TypeScript plugin answers `getCodeFixesAtPosition` for an MX diagnostic's range with one code fix per fix, whose edits apply to the `.mx` file (the `<effect>` error's "Rename to `<script>`" renames the open and the close tag, and a dialect's diagnostic can carry its own fixes); requests for TypeScript's own error codes, and for files with no such diagnostic, go to TypeScript unchanged. `mx-tsc` prints each fix on a `fix:` line under the diagnostic, e.g. ``fix: Rename to `<script>`: replace 2:4-2:10 with "script"; replace 2:17-2:23 with "script"`` (1-based `line:column`, end exclusive, new text quoted), the same with and without `--pretty`. The plugin also exports `applicableFixes` and `mxCodeFixes`.
