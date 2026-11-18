---
packages: [core, html]
kind: Fixed
---
On the html target, a custom tag whose build hook emits a delegated `<style>` (`ctx.build.delegatedTag("style", …)`) no longer has its own attributes refused as `<style>` attributes: `<widget a="1"/>` used to fail with `` The `style` does not support html attributes. `` at `a`, and now renders the `<style>`. The bare `<style>` attribute refusal now comes from core on every host, html included, with the same message, code (`MX_INVALID_ATTRIBUTE`) and position as before; the tag's arguments, parameters and attribute tags are still reported first, as in Marko.
