---
packages: [astro]
kind: Fixed
---
A head class merged into an authored `class` (`<div.a class="b"/>`, `<div.a class=x/>`) compiles on Astro and renders `class="a b"`, as on the other hosts; before, it threw `expression has no source position` at line 0, column 0. On a bare `<style>` (`<style.a class="b">`) the merged class now gets the core `<style>` refusal at the authored `class` instead of that error.
