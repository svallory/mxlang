---
packages: [core, html, astro, angular]
kind: Fixed
---
A custom tag whose `transform` hook builds an `<html-comment>`, `<html-script>`, `<html-style>` or `<try>` is no longer refused for its own attribute tags or tag params, nor (except under `<html-comment>`) its tag variable, as if they were the built tag's (html, Astro): `<widget|x|>a</widget>` building an empty `<html-comment>` renders `<!---->`, and a widget's own `<@placeholder>` no longer trips the `<try>` placeholder refusal. Core now refuses these fields on the authored tag only, with the same text and position as before. The html target refuses a `<@placeholder>` a hook builds on a `<try>` instead of dropping it. Angular refuses an `<html-comment>`'s tag params and arguments, as Marko does, instead of dropping them.
