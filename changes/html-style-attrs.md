---
packages: [html]
kind: Changed
---
As in Marko, the core `<style>` now refuses attributes on the html target instead of dropping them from the output: an authored attribute (`<style media="print">`), a value-less one (`<style scoped>`), a spread (`<style ...attrs>`) and the `#id` and authored `class` shorthands (`<style#a>`, `<style.a class="b">`) are `MX_INVALID_ATTRIBUTE` at the first attribute (at the id word for `<style#a>`), with stock Marko 6.4.4's message: `` The `style` does not support html attributes. For a native html [`<style>` tag](https://markojs.com/docs/reference/core-tag#style) use the `html-style` core tag instead. `` Write `<html-style>` for a `<style>` element that keeps its attributes. The file-extension shorthand (`<style.less>`, `<style.module.css>`) is not an attribute and still compiles. A `style` contract in `customTags` turns the refusal off, and so does the `none` tag-rules preset.
