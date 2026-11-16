---
packages: [angular]
kind: Changed
---

Two Angular template errors no longer blame the author's syntax on MX or Marko. An unresolved `<switch>` or `<case>` tag now reads ``Unable to find entry point for custom tag `<switch>`. There is no `<switch>` control-flow tag; use `<if=…>` / `<else if=…>`.``, and a structural attribute after another attribute reads ``…after `class=…`, it reads as a multiplication, so this does not parse. Make it the first attribute of the tag, or write `<if=cond>…</if>` instead.`` mx-tsc and the tsserver plugin print the new texts.
