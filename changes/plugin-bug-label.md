---
packages: [html]
kind: Fixed
---

A tag body passed to a callee whose input declares no `content` (for example `<Card title="x">hello</Card>` against a `.ts` tag whose input is `{ title: string }`) still reports TS2353 `'content' does not exist`, but no longer labels it "in MX-generated code, not yours: an MX bug": the generated `content` key now maps onto the tag name, for type-check diagnostics only, so the error is reported on the tag name, where a missing required prop is.
