---
packages: [core, data]
kind: Added
---

- `@mxlang/core/syntax/member`: Mesh's `&` member sigil module (all three
  trigger positions) ships in the tarball as a documented reference for
  extension authors (`dist/syntax/member.js` and `.d.ts`; the README shows
  the `import` and the copy-and-rename path). It is built on the public hook
  API only; core stays host-agnostic.
- core: an IR tag a syntax module builds with `ctx.child` carries
  `trigger: { id, span, text }` (the trigger row's id, its source span and
  authored text, the facts `extra.mxTrigger` carries on expression stand-ins).
  Authored tags have none. Additive.
- data: `DataTag.trigger?: { id: string; span: Span; text: string }` exposes
  it, so `&title` and an authored `<member name="title"/>` are told apart
  without comparing spans.
- data: `DataImportName` gains `span` (the imported name as written; the
  binding for a default or namespace import) and `localSpan` (the alias,
  only when the local differs from the imported name).

`parseData`'s option shape is unchanged. All additions are optional/additive.
