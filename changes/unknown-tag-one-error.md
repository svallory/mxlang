---
packages: [core]
kind: Changed
---

Under `unknownTags: "reject"`, an unknown tag inside a parent whose `children` contract is closed now reports one error, `MX_UNKNOWN_TAG`; the `MX_TAG_NOT_ALLOWED` error it also got, at the same position, is gone. A tag with no contract is the cause and "not allowed here" its symptom, so a consumer no longer filters the pair by message text. A declared tag the parent does not allow keeps `MX_TAG_NOT_ALLOWED`; `MX_TEXT_NOT_ALLOWED` and every other error are untouched, and `unknownTags: "allow"` reports exactly what it did.
