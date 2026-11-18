---
packages: [core, html]
kind: Fixed
---
On html, a custom tag whose hook builds a `<style>` (`ctx.build.delegatedTag("style", …)`) is no longer refused for its own attribute tags, tag params or tag variable as if they were written on `<style>`: `<widget><@item/></widget>` and `<widget|x|>…</widget>` render `<style></style>`. An authored `<style>`'s params, attribute tags and tag variable are still refused with the same message and position, now by core (on the claimed tag and on a contract-only `style` registration).
