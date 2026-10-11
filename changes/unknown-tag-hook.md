---
packages: [core]
kind: Added
---

A dialect may explain a tag that has no contract. `Dialect.explainUnknownTag(tag)` receives the tag's name and spans, the authored tags around it (each with the contract in force inside it), the call's `unknownTags` mode, the file and its text, and returns an explanation `{ message, code?, at? }` or `undefined`. An explained tag is the dialect's one error for it in both modes, replacing `MX_UNKNOWN_TAG` and, in a closed parent, `MX_TAG_NOT_ALLOWED`, so the dialect no longer lowers a file twice and filters core's messages to say it; the result has no IR, in `"allow"` mode too. The hook sees the same tag whether the file lowered or lowering failed elsewhere, and `lowerSource` stays at one lowering. A hook that throws or returns a malformed value is one `MX_DIALECT_HOOK_ERROR` at the tag. `ContractData` carries the contract's `defaultTag`, absent when it states none. New types `UnknownTag`, `UnknownTagAncestor` and `UnknownTagExplanation` (`@unstable`); a dialect module may export the hook.
