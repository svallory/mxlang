---
packages: [host-preact, host-react, host-hono]
kind: Fixed
---

A `.mx` component on the JSX hosts whose `Input` types `content` as a function no longer fails `tsc` with TS2322 in its own file: the module preamble casts the normalized body instead of annotating `input` with an `unknown` `content`.
