---
packages: [core]
kind: Fixed
---

Under `unknownTags: "reject"`, with no dialect hook, an unrelated error elsewhere in a file no longer makes one tag report twice. When lowering failed on that other error, a tag the parent's `children` contract does not allow was reported as `MX_TAG_NOT_ALLOWED` and again as `MX_UNKNOWN_TAG`, at the same position; the dropped error came back through the error list it was collected with. It now gives the one `MX_UNKNOWN_TAG`, as it does when the file lowers. This was in 0.1.0-alpha.18.
