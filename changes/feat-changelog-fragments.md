---
packages: []
kind: Added
---
Changelog fragments: a PR that touches `packages/*/src` or `packages/*/package.json` adds `changes/<branch-slug>.md` (front matter `packages` + `kind`, body = the entry), and `bun run changelog:assemble` folds fragments into each package CHANGELOG's `## Unreleased` section — ending the top-of-changelog conflicts that serialised merge trains (decision 190 item 4).
