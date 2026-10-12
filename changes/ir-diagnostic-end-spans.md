---
packages: [core, target-registry]
kind: Added
---
Diagnostics carry where they end. `IrDiagnostic`, `TranslateError`, `MxWarning` and `DialectDiagnostic` take an optional `end` (`{ line, column, offset }` on the first and last, `{ line, column }` on the errors and warnings), exclusive, so a tool can underline the range instead of a character. A diagnostic that blames a whole tag ends at the end of `<name`, an attribute after its value, an expression at its last character, and a parse error where the parser's range ends. A file-level diagnostic has no `end`, and `end.offset` is `-1` only when `file` names another file, as for `offset`. A `DialectDiagnostic` whose problem is in another file puts the range on `origin.end`. A dialect's `tagFile` hook can give a diagnostic's end as `endLine` and `endColumn`. Every field is optional and the start fields are unchanged.
