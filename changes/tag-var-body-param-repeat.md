---
packages: [core]
kind: Fixed
---

Refuse a tag-variable declaration that repeats a parameter of its immediate attribute-tag, custom-call or `<await>` body, matching the existing `<for>` and `<define>` rule. Nested bodies may still shadow a parameter, and a parameter named `input` remains valid. This rule does not apply under `tagRules: "none"`.
