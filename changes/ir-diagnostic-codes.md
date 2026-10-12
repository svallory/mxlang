---
packages: [core]
kind: Added
---

Every error `lowerSource` and the template compilers report now carries a stable code, and so does every core warning: `IrDiagnostic.code` on the IR entry, `TranslateError.diagnosticCode` on a template compile, `MxWarning.code` on a warning. Match on the code; the wording may change, the code does not. Messages, positions and severities are unchanged. Codes come from one catalogue, by family:

- **Lowering**, the language's own rules: `MX_INVALID_IF`, `MX_INVALID_FOR`, `MX_UNKNOWN_ATTRIBUTE_TAG` and the rest.
- **Contract**, a call checked against its tag's contract: `MX_UNKNOWN_TAG`, `MX_TAG_NOT_ALLOWED`, `MX_TEXT_NOT_ALLOWED`, `MX_MISSING_ATTRIBUTE`, `MX_UNKNOWN_ATTRIBUTE`, `MX_RESERVED_TAG`, `MX_INVALID_DEFAULT_TAG` and the rest.
- **Data file**, what a static data tree cannot hold: `MX_STRUCTURAL_CONSTRUCT`, `MX_NOT_IN_DATA_FILE`.
- **Registration**: contracts, configuration, dialects and tag files (`MX_INVALID_CONTRACT`, `MX_TAG_FILE_ERROR`, `MX_TAG_FILE_CYCLE`, `MX_INVALID_DIALECT_CONTRACT`).
- **Hook defaults**: `MX_DIALECT_ERROR` and `MX_TAG_ERROR` for a hook's error that gave no code, `MX_DIALECT_WARNING` for its warning, `MX_DIALECT_HOOK_ERROR` and `MX_TAG_HOOK_ERROR` for a hook that broke its contract.
- **Warnings**: every core warning, among them `MX_DUPLICATE_ATTRIBUTE`, `MX_IGNORED_CONFIG` and `MX_SHADOWED_CONTRACT`.
- **Parse**: the front end's own errors reach `code` too, `MX_PARSE_EXPRESSION` for a Babel error in an expression, `MX_EXPECTED_SINGLE_EXPRESSION` for a second expression where one is expected, the front end's own rules (`MX_TAG_NAME_MISSING`, `MX_ATTRIBUTE_TAG_AT_ROOT`, ...) and one `MX_PARSE_*` code per template-parser error (`MX_PARSE_MISSING_END_TAG`, `MX_PARSE_MALFORMED_OPEN_TAG`, ...).
- **Internal**: `MX_INTERNAL_ERROR` for an error that reaches the entry without a code, which is a bug in MX.

The specification lists every code (§13.7.5 Diagnostic codes).

The five codes a closed vocabulary turns on (`MX_UNKNOWN_TAG`, `MX_TAG_NOT_ALLOWED`, `MX_TEXT_NOT_ALLOWED`, `MX_EXPECTED_SINGLE_EXPRESSION`, `MX_DUPLICATE_ATTRIBUTE`) and `MX_TAG_FILE_ERROR` keep their meanings and their sites.

Hooks may pass `at` as a span (`{ sourceStart, sourceEnd }`) as well as a position: `unit.fail(message, { at })` in `afterLower` and a contract hook's `ctx.fail(message, { at })` keep the span. `unit.warn(message, { at, code })` places and codes a dialect's warning.

The `MX_` prefix is reserved for MX's own codes. A hook that passes a code starting with `MX_` gets `MX_DIALECT_HOOK_ERROR` (`MX_TAG_HOOK_ERROR` from a contract hook) in place of its diagnostic; a `tagFile` hook may still forward the diagnostics `ctx.lower()` gave it, codes included. Give your dialect's codes your own prefix.

Changed: the IR entry's `invalid-default-tag` code is now `MX_INVALID_DEFAULT_TAG`. No other code is renamed.
