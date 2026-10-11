---
packages: [core]
kind: Added
---

Four more errors carry a stable code, so a consumer matches the code and not the text: `MX_UNKNOWN_TAG` (a tag with no contract under `unknownTags: "reject"`), `MX_TAG_NOT_ALLOWED` and `MX_TEXT_NOT_ALLOWED` (a child tag or text a `children` contract does not allow), and `MX_EXPECTED_SINGLE_EXPRESSION` (``Expected a single expression, but found `…` after it.``). Each reaches `IrDiagnostic.code` from `lowerSource`, and `TranslateError.diagnosticCode` from a template compile; the parse error's code rides a non-enumerable `diagnosticCode` on the `CompileError`. The code also survives the "inside the unknown tag" label an error gets. No message changes.
