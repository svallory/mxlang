---
packages: [core]
kind: Added
---

`mx.strict: true` with no `mx.host` or `mx.target` is now a `strict-ignored` policy warning ("mx.strict is ignored without mx.host or mx.target"), positioned at the `strict` key, instead of being dropped silently. The default target stays non-strict.
