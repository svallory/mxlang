---
packages: [core]
kind: Fixed
---
On html, a custom tag's hook that builds a `<style>` with attributes (`ctx.build.delegatedTag("style", children, attributeTags, attrs)`) and no `style` contract now fails with the bare `<style>` message, as an authored `<style media="print">` does, instead of dropping the attributes: `` `<name>`: The `style` does not support html attributes. For a native html [`<style>` tag](https://markojs.com/docs/reference/core-tag#style) use the `html-style` core tag instead. `` (`MX_TAG_HOOK_ERROR`, at the first attribute). A registered `style` contract keeps the attributes, and the `none` tag-rules preset skips the refusal.
