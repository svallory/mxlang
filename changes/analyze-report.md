---
packages: [core]
kind: Added
---
`AnalyzeContext.report(message, options?)` (`@unstable`): an `analyze` hook reports several positioned errors without throwing. It takes `ctx.fail`'s options, defaults and refusals; every report is a diagnostic of the file, a hook that reported counts as failed (in partial mode the tag is omitted like any analyze-failed tag), and a call after `analyze` returned is `MX_TAG_HOOK_ERROR`.
