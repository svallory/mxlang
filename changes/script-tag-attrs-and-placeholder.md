---
packages: [core]
kind: Fixed
---
A built-in `<script>` with an attribute other than its own value (`<script async>`, `<script src="/x.js">`, `type`, `defer`, `id`, `class`, a `#id`/`.class` shorthand, …), a bound or modified value (`value:=x`), a spread, or with a `${…}` placeholder in its body (in code, in a quoted string or in a regular expression; a `${…}` inside a template literal is the script's own) is a compile error, `MX_INERT_TAG_SHAPE`, at the attribute or the placeholder, and the message says to use `<html-script>` for a native html `<script>` element. Both compiled before with nothing said, the attribute discarded and the body never read, and stock Marko refuses both. `<html-script>`, a `<script>` a caller registered as a custom tag and a `<script>` under the `none` tag rules are not checked.
