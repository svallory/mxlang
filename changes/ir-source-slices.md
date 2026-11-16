---
packages: [core]
kind: Changed
---
A destructuring tag variable keeps its authored spelling in the IR: `<const/{a,b}=o/>` lowers to `Const.name` `{a,b}` (was the generator's `{ a, b }`), and a tag's `/var` pattern (`DelegatedTag.tag.var`, `Component.var`, `TagCall.var`) and the error text quoting it do the same. The text is verbatim (spacing, line breaks, comments), without the top-level annotation, trimmed at the end; identifier names are unchanged. Known limit: under a stripping compile, a pattern holding TypeScript below its annotation (a cast or a typed arrow in a default, `{a = (1 as number)}`) keeps the generator text (`{ a = 1 }`). `IR_VERSION` is 17.
