---
packages: [core]
kind: Fixed
---

When two diagnostics apply, the real error now wins. A host that declares `<script>` as an `error` row refuses the tag with that refusal alone, as an `unsupported` row does. A throwing compile reports a `<script>` placeholder, then the body's syntax error, before the head and attribute refusals, as stock Marko does. Under `structural: "reject"`, an `<if>` or `<for>` holding attribute tags inside a registered tag reports `MX_STRUCTURAL_CONSTRUCT` instead of `MX_INVALID_ATTRIBUTE_TAG`. `<try>` and `<return>` under a tag with a contract report `MX_NOT_IN_DATA_FILE` instead of `MX_TAG_NOT_ALLOWED`. A file whose `analyze` hooks fail on several tags reports each tag's error, not only the first. `<html-script>`'s raw-text body is read as raw text on a host that registers no core taglib (the shared JSX hosts' whole-file compile).
