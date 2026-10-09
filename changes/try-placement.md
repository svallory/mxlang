---
packages: [core]
kind: Fixed
---

Refuse the `<try>` shapes Marko 6.4 refuses: a `<try>` with no body content, and a `<try>` with neither `<@catch>` nor `<@placeholder>` (it would have no effect), each positioned at the `<try>` tag on every target. A `<@catch>`/`<@placeholder>` written under `<if>`/`<for>` was already refused at the misplaced tag.
