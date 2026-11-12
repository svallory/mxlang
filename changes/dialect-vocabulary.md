---
packages: [core, parser, html, solid, preact, astro, angular]
kind: Fixed
---

A dialect's `messageVocabulary` now reaches the messages that ignored it. The parser's `tagShorthands: false` refusals (`#id`, a leading `.`) name an attribute in the dialect's noun, through a new optional `SyntaxTable.anAttribute` that core sets from the vocabulary. The html target's unresolved-tag and element attribute-tag messages, and every host's unresolved-tag message, use the file's voice (`formatTag`, the attribute noun); core exports `voiceOfCtx` and the `Voice` type for it. A shorthand class beside a `class` attribute is now `MX_MERGED_SHORTHAND_CLASS` (was `MX_DIALECT_HOOK_ERROR`), so a dialect's `diagnosticCodes` map can rename it, and its message no longer shows the `.a` token.
