---
packages: [core]
kind: Changed
---
Under `structural: "reject"`, an orphan `else` or `else-if` now names the tag the author wrote as part of the `if` construct: "`else` is part of `if`, and Kit files are static, so they do not evaluate `if`" for a dialect with that vocabulary. Each tag goes through `messageVocabulary.formatTag`, and the file noun uses `messageVocabulary.file`. The diagnostic stays `MX_STRUCTURAL_CONSTRUCT` at the same position, with no hint to add an `if`. Pass, unset, no-dialect default and template paths are unchanged; a dialect that sets `structural: "reject"` itself (Mesh's does) gets the new text. Mesh-visible: update snapshots of the orphan message; the trailing ``evaluate `if` `` shape used to identify the construct is unchanged.
